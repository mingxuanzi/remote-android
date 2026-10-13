import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { config } from './config';
import { adb, serialOf, waitForBoot } from './adb';
import { lockOrientationValue } from './docker';
import { InstanceRow } from './db';
import { ClientMsg, encodeV1, StreamSession } from './control';

export const CONFIG_FLAG = 1n << 63n; // 配置包(SPS/PPS)
export const KEYFRAME_FLAG = 1n << 62n;

export interface Frame {
  /** 原始 8 字节 ptsAndFlags(含 config/keyframe 标志位),原样转发给前端 */
  ptsAndFlags: bigint;
  payload: Buffer;
}

export interface VideoMeta {
  width: number;
  height: number;
  codec: string; // scrcpy 1.x 固定 h264
}

type ParseState = 'dummy' | 'header' | 'payload';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 一个实例的 scrcpy 推流会话(scrcpy-server 1.x 协议):
 *   adb forward tcp:<port> localabstract:scrcpy
 *   第 1 条 TCP 连接 = 视频流(dummy byte + [ptsAndFlags 8B][size 4B][payload] 帧序列)
 *     ※ 1.x 没有 codec meta(2.x 才有);宽高取自实例记录,编码固定 H264
 *   第 2 条 TCP 连接 = 控制通道(28B 触控 / 14B 按键 / 文本 / 滚动)
 *
 * 时序要点:adb forward 在 server 尚未 listen 时会 "accept 后立即关闭",
 * 因此视频通道必须等到 dummy byte 才算就绪,否则重试;且必须先确认视频通道
 * 再连控制通道,避免控制连接被 server 抢先 accept 成视频通道导致角色错位。
 */
export class ScrcpySession extends EventEmitter implements StreamSession {
  readonly instance: InstanceRow;
  readonly hasVideoFrames = true; // 视频经 WS 二进制帧下发
  meta: VideoMeta | null = null;

  private videoSocket?: net.Socket;
  private controlSocket?: net.Socket;
  private serverProc?: ChildProcessWithoutNullStreams;
  private forwardPort = 0;
  private closed = false;

  private buf = Buffer.alloc(0);
  private state: ParseState = 'dummy';
  private pendingPtsAndFlags = 0n;
  private pendingSize = 0;

  private constructor(instance: InstanceRow) {
    super();
    this.instance = instance;
  }

  static async start(instance: InstanceRow): Promise<ScrcpySession> {
    const session = new ScrcpySession(instance);
    await session.bootstrap();
    return session;
  }

  private log(m: string): void {
    console.log(`[scrcpy:${this.instance.name}] ${m}`);
  }

  private async bootstrap(): Promise<void> {
    const serial = serialOf(this.instance.name);

    // 1. 等 Android 完全启动(未 boot 完时 server 会起不来、push 的文件也可能被覆盖)
    this.log('waitForBoot...');
    await waitForBoot(serial);
    this.log('booted');

    // 2. 每次都重推 scrcpy-server.jar(42KB 瞬时完成,避免 /data/local/tmp 残留状态不一致)
    const jarRemote = '/data/local/tmp/scrcpy-server.jar';
    await adb(['-s', serial, 'push', config.scrcpyServerPath, jarRemote], 120_000);
    this.log('jar pushed');

    // 3. 建立 adb forward(随机本地端口,避免多实例冲突)
    this.forwardPort = 27183 + Math.floor(Math.random() * 2000);
    await adb(['-s', serial, 'forward', `tcp:${this.forwardPort}`, 'localabstract:scrcpy']);
    this.log(`forward tcp:${this.forwardPort}`);

    // 4. 启动 scrcpy-server(前台进程持有,session 关闭时杀掉)
    //    注意:1.x 不认识 send_codec_meta(2.x 参数),不要传
    const serverCmd =
      `CLASSPATH=${jarRemote} app_process / com.genymobile.scrcpy.Server ` +
      [
        config.scrcpyVersion,
        'log_level=warn',
        `bit_rate=${config.scrcpyBitrate}`,
        `max_fps=${config.scrcpyFps}`,
        'tunnel_forward=true',
        'send_frame_meta=true',
        'send_device_meta=false',
        `lock_video_orientation=${lockOrientationValue(this.instance)}`,
        'control=true',
        'stay_awake=true',
      ].join(' ');
    this.serverProc = spawn('adb', ['-s', serial, 'shell', serverCmd]);
    this.serverProc.stderr.on('data', (d: Buffer) => this.emit('serverLog', d.toString()));
    this.serverProc.on('error', (e) => this.log(`spawn error: ${e.message}`));
    this.serverProc.on('close', (code) => {
      this.log(`server process exited code=${code}`);
      this.close();
    });

    // 5. 视频通道:TCP 连上不算数,必须收到 dummy byte(server accept 后立即下发)
    let lastErr: unknown;
    for (let i = 0; i < 40 && !this.closed; i++) {
      const s = await this.connectRaw().catch((e: unknown) => { lastErr = e; return null; });
      if (!s) { await sleep(300); continue; }

      s.on('data', (chunk) => this.onData(chunk)); // 解析器从 dummy byte 开始消费,不丢字节
      const ready = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 3_000);
        s.once('data', () => { clearTimeout(timer); resolve(true); });
        s.once('close', () => { clearTimeout(timer); resolve(false); });
        s.once('error', () => { clearTimeout(timer); resolve(false); });
      });
      if (ready) {
        this.videoSocket = s;
        break;
      }
      lastErr = new Error('连接在 dummy byte 前被关闭(server 未就绪)');
      s.removeAllListeners();
      s.destroy();
      await sleep(300);
    }
    if (!this.videoSocket) {
      throw new Error(`连接 scrcpy 视频通道失败: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
    }
    this.log('video socket ready (dummy byte received)');
    this.videoSocket.on('error', (e) => { this.log(`video socket error: ${e.message}`); this.close(); });
    this.videoSocket.on('close', (hadError) => { this.log(`video socket closed hadError=${hadError}`); this.close(); });

    // 6. 控制 socket 是第二条连接(协议约定:第一条=视频,第二条=控制)
    //    必须在视频通道就绪后再连,避免角色错位
    let controlOk = false;
    for (let i = 0; i < 40 && !this.closed; i++) {
      const s = await this.connectRaw().catch(() => null);
      if (s) { this.controlSocket = s; controlOk = true; break; }
      await sleep(300);
    }
    if (!controlOk) throw new Error('连接 scrcpy 控制通道失败');
    this.controlSocket!.on('error', () => void 0);
    this.log('control socket connected');

    // 7. 宽高取自实例记录(1.x 协议不下发 codec meta)
    this.meta = { width: this.instance.width, height: this.instance.height, codec: 'h264' };
    this.emit('meta', this.meta);
    this.log('session ready');
  }

  private connectRaw(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.forwardPort, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  }

  /** 视频流帧解析状态机(1.x:dummy byte 之后直接是帧序列) */
  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.state === 'dummy') {
        if (this.buf.length < 1) return;
        this.buf = this.buf.subarray(1);
        this.state = 'header';
      } else if (this.state === 'header') {
        if (this.buf.length < 12) return;
        this.pendingPtsAndFlags = this.buf.readBigUInt64BE(0);
        this.pendingSize = this.buf.readUInt32BE(8);
        this.buf = this.buf.subarray(12);
        this.state = 'payload';
      } else {
        if (this.buf.length < this.pendingSize) return;
        const frame: Frame = {
          ptsAndFlags: this.pendingPtsAndFlags,
          payload: Buffer.from(this.buf.subarray(0, this.pendingSize)),
        };
        this.buf = this.buf.subarray(this.pendingSize);
        this.state = 'header';
        this.emit('frame', frame);
      }
    }
  }

  /** 写 scrcpy 控制消息(1.x 编码) */
  dispatchControl(msg: ClientMsg): void {
    const { width, height } = this.meta ?? { width: this.instance.width, height: this.instance.height };
    const buf = encodeV1(msg, width, height);
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
    this.controlSocket?.destroy();
    this.serverProc?.kill('SIGKILL');
    const serial = serialOf(this.instance.name);
    adb(['-s', serial, 'forward', '--remove', `tcp:${this.forwardPort}`], 5_000).catch(() => void 0);
    this.emit('closed');
  }
}

export function frameToWire(frame: Frame): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(frame.ptsAndFlags, 0);
  header.writeUInt32BE(frame.payload.length, 8);
  return Buffer.concat([header, frame.payload]);
}
