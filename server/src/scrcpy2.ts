import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { config } from './config';
import { adb, serialOf, waitForBoot } from './adb';
import { lockOrientationValue } from './docker';
import { InstanceRow } from './db';
import { ClientMsg, encodeV2, StreamSession } from './control';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface V2Frame {
  ptsAndFlags: bigint;
  payload: Buffer;
}

type VideoState = 'dummy' | 'codecMeta' | 'header' | 'payload';
type AudioState = 'codecMeta' | 'header' | 'payload';

/**
 * WS v2 推流会话(scrcpy-server 2.4):视频 + 音频 + 控制全走 WebSocket。
 *
 * 与 1.x 的差异:
 *  - 三条 socket 按序 accept:video → audio → control
 *  - video: dummy(1B) + codecMeta(12B: codec/width/height) + 帧序列
 *  - audio: codecMeta(4B: codec id) + 帧序列(audio_codec=raw → PCM s16le 48kHz 立体声)
 *  - 控制消息布局不同(触控 32B、滚动 i16 定点),见 control.ts encodeV2
 */
export class Scrcpy2Session extends EventEmitter implements StreamSession {
  readonly instance: InstanceRow;
  readonly hasVideoFrames = true;
  meta: { width: number; height: number; codec: string } | null = null;

  private videoSocket?: net.Socket;
  private audioSocket?: net.Socket;
  private controlSocket?: net.Socket;
  private serverProc?: ChildProcessWithoutNullStreams;
  private forwardPort = 0;
  /** 会话唯一 scid:同设备多个 scrcpy 2.x 会话共存时 abstract socket 名不冲突 */
  private readonly scid = 1 + Math.floor(Math.random() * 0x7fffff00);
  private closed = false;

  private vBuf = Buffer.alloc(0);
  private vState: VideoState = 'dummy';
  private vPtsAndFlags = 0n;
  private vSize = 0;

  private aBuf = Buffer.alloc(0);
  private aState: AudioState = 'codecMeta';
  private aPts = 0n;
  private aSize = 0;

  private constructor(instance: InstanceRow) {
    super();
    this.instance = instance;
  }

  static async start(instance: InstanceRow): Promise<Scrcpy2Session> {
    const s = new Scrcpy2Session(instance);
    await s.bootstrap();
    return s;
  }

  private log(m: string): void {
    console.log(`[v2:${this.instance.name}] ${m}`);
  }

  private async bootstrap(): Promise<void> {
    const serial = serialOf(this.instance.name);

    await waitForBoot(serial);
    this.log('booted');

    const jarRemote = '/data/local/tmp/scrcpy-server2.jar';
    await adb(['-s', serial, 'push', config.scrcpy2ServerPath, jarRemote], 120_000);

    this.forwardPort = 27183 + Math.floor(Math.random() * 2000);
    const socketName = `scrcpy_${this.scid.toString(16).padStart(8, '0')}`;
    await adb(['-s', serial, 'forward', `tcp:${this.forwardPort}`, `localabstract:${socketName}`]);

    const serverCmd =
      `CLASSPATH=${jarRemote} app_process / com.genymobile.scrcpy.Server ` +
      [
        config.scrcpy2Version,
        // scid 按十六进制解析(Options.java: Integer.parseInt(value, 0x10)),必须传 hex 字符串
        `scid=${this.scid.toString(16)}`,
        'log_level=warn',
        'tunnel_forward=true',
        'video=true',
        'audio=true',
        'video_codec=h264',
        `video_bit_rate=${config.scrcpyBitrate}`,
        `max_fps=${config.scrcpyFps}`,
        'audio_codec=raw', // PCM s16le 48kHz 立体声,前端 AudioWorklet 直接播
        // 周期关键帧:WebRTC 保活 IDR 重放/晚进观众出图都依赖 IDR,
        // 间隔 2s 保证参考链一致(IDR 重放后接续的 P 帧参考同一 IDR,不再拖影)
        'video_codec_options=i-frame-interval:float=2',
        // 锁死视频方向(值按实例方向模式计算:natural/landscape/portrait → 0 或 1):
        // 防止应用强制旋转导致输出帧尺寸中途变化、解码器按旧 SPS 解出花屏
        `lock_video_orientation=${lockOrientationValue(this.instance)}`,
        'send_frame_meta=true',
        'send_codec_meta=true',
        'send_device_meta=false', // 2.x 默认还会发 64B 设备名,会顶掉 codecMeta 的解析
        'control=true',
        'stay_awake=true',
      ].join(' ');
    this.serverProc = spawn('adb', ['-s', serial, 'shell', serverCmd]);
    this.serverProc.stderr.on('data', (d: Buffer) => this.emit('serverLog', d.toString()));
    this.serverProc.on('close', (code) => {
      this.log(`server exited code=${code}`);
      this.close();
    });

    // 顺序即角色:video → audio → control;video 要先收到 dummy byte
    this.videoSocket = await this.connectVideoSocket();
    this.log('video socket ready');
    this.audioSocket = await this.connectRawRetry();
    this.audioSocket.on('data', (c) => this.onAudioData(c));
    this.audioSocket.on('error', () => void 0);
    this.log('audio socket connected');
    this.controlSocket = await this.connectRawRetry();
    this.controlSocket.on('error', () => void 0);
    this.log('control socket connected');

    this.videoSocket.on('error', () => this.close());
    this.videoSocket.on('close', () => this.close());
    this.log('session ready');
  }

  private connectRaw(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.forwardPort, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  }

  private async connectRawRetry(): Promise<net.Socket> {
    let lastErr: unknown;
    for (let i = 0; i < 40 && !this.closed; i++) {
      try {
        return await this.connectRaw();
      } catch (e) {
        lastErr = e;
        await sleep(300);
      }
    }
    throw new Error(`连接失败: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
  }

  /** 视频 socket:收到 dummy byte 才算就绪(解析器同步挂上,不丢字节) */
  private async connectVideoSocket(): Promise<net.Socket> {
    let lastErr: unknown;
    for (let i = 0; i < 40 && !this.closed; i++) {
      const s = await this.connectRaw().catch((e: unknown) => { lastErr = e; return null; });
      if (!s) { await sleep(300); continue; }
      s.on('data', (chunk) => this.onVideoData(chunk));
      const ready = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 3_000);
        s.once('data', () => { clearTimeout(timer); resolve(true); });
        s.once('close', () => { clearTimeout(timer); resolve(false); });
        s.once('error', () => { clearTimeout(timer); resolve(false); });
      });
      if (ready) return s;
      lastErr = new Error('dummy byte 前连接被关闭(server 未就绪)');
      s.removeAllListeners();
      s.destroy();
      await sleep(300);
    }
    throw new Error(`连接 scrcpy 视频通道失败: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
  }

  /** 视频帧解析:dummy(1B) → codecMeta(12B) → [pts 8B][size 4B][payload] */
  private onVideoData(chunk: Buffer): void {
    this.vBuf = Buffer.concat([this.vBuf, chunk]);
    for (;;) {
      if (this.vState === 'dummy') {
        if (this.vBuf.length < 1) return;
        this.vBuf = this.vBuf.subarray(1);
        this.vState = 'codecMeta';
      } else if (this.vState === 'codecMeta') {
        if (this.vBuf.length < 12) return;
        const codec = this.vBuf.toString('latin1', 0, 4).replace(/\0.*$/, '');
        const width = this.vBuf.readUInt32BE(4);
        const height = this.vBuf.readUInt32BE(8);
        this.vBuf = this.vBuf.subarray(12);
        this.vState = 'header';
        this.meta = { width, height, codec: codec || 'h264' };
        this.emit('meta', this.meta);
        this.log(`codec meta: ${codec} ${width}x${height}`);
      } else if (this.vState === 'header') {
        if (this.vBuf.length < 12) return;
        this.vPtsAndFlags = this.vBuf.readBigUInt64BE(0);
        this.vSize = this.vBuf.readUInt32BE(8);
        this.vBuf = this.vBuf.subarray(12);
        this.vState = 'payload';
      } else {
        if (this.vBuf.length < this.vSize) return;
        const frame: V2Frame = {
          ptsAndFlags: this.vPtsAndFlags,
          payload: Buffer.from(this.vBuf.subarray(0, this.vSize)),
        };
        this.vBuf = this.vBuf.subarray(this.vSize);
        this.vState = 'header';
        this.emit('videoFrame', frame);
      }
    }
  }

  /** 音频帧解析:codecMeta(4B) → [pts 8B][size 4B][PCM payload] */
  private onAudioData(chunk: Buffer): void {
    this.aBuf = Buffer.concat([this.aBuf, chunk]);
    for (;;) {
      if (this.aState === 'codecMeta') {
        if (this.aBuf.length < 4) return;
        const codec = this.aBuf.toString('latin1', 0, 4).replace(/\0.*$/, '');
        this.aBuf = this.aBuf.subarray(4);
        this.aState = 'header';
        this.log(`audio codec: ${codec || 'raw(PCM)'}`);
      } else if (this.aState === 'header') {
        if (this.aBuf.length < 12) return;
        this.aPts = this.aBuf.readBigUInt64BE(0);
        this.aSize = this.aBuf.readUInt32BE(8);
        this.aBuf = this.aBuf.subarray(12);
        this.aState = 'payload';
      } else {
        if (this.aBuf.length < this.aSize) return;
        const payload = Buffer.from(this.aBuf.subarray(0, this.aSize));
        this.aBuf = this.aBuf.subarray(this.aSize);
        this.aState = 'header';
        this.emit('audioFrame', { pts: this.aPts, payload });
      }
    }
  }

  dispatchControl(msg: ClientMsg): void {
    const { width, height } = this.meta ?? { width: this.instance.width, height: this.instance.height };
    const buf = encodeV2(msg, width, height);
    if (buf && this.controlSocket && !this.controlSocket.destroyed) {
      this.controlSocket.write(buf);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.log('session close()');
    this.videoSocket?.destroy();
    this.audioSocket?.destroy();
    this.controlSocket?.destroy();
    this.serverProc?.kill('SIGKILL');
    const serial = serialOf(this.instance.name);
    adb(['-s', serial, 'forward', '--remove', `tcp:${this.forwardPort}`], 5_000).catch(() => void 0);
    this.emit('closed');
  }
}
