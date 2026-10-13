import { EventEmitter } from 'node:events';
import { config } from './config';
import { InstanceRow } from './db';
import { ClientMsg, StreamSession } from './control';
import { Scrcpy2Session } from './scrcpy2';
import { RtspPublisher } from './rtsp';
import { H264RtpPacketizer, extractSpsPps, ptsToTs90 } from './rtp';

const CONFIG_FLAG = 1n << 63n;
const KEYFRAME_FLAG = 1n << 62n;
const PTS_MASK = ~(CONFIG_FLAG | KEYFRAME_FLAG);

/**
 * WebRTC 低延迟链路(纯 JS 实现,无 ffmpeg 黑盒):
 *
 *   Scrcpy2Session(scrcpy 2.4:video/audio/control 三通道)
 *     ├─ video(AnnexB)→ RTP 打包(RFC 6184)→ 极简 RTSP 客户端 → MediaMTX → WHEP → 浏览器
 *     ├─ audio(PCM) → 复用 WS 控制通道下发 → 前端 AudioWorklet(与 v2 模式相同)
 *     └─ control   → dispatchControl(2.x 协议编码)
 *
 * 关键帧策略:redroid 编码器忽略 i-frame-interval,不产周期 IDR,
 * 所以不做"重放旧 IDR 保活"(参考链错乱会拖影)。改为:
 *  - 新观众接入时 restartCapture():重启采集拿一波全新 IDR(约 1s 闪断)
 *  - 发布通道被 MediaMTX 读超时杀掉后,下一帧到达时自动重建
 */
export class RtcSession extends EventEmitter implements StreamSession {
  readonly instance: InstanceRow;
  readonly hasVideoFrames = false; // 视频走 WebRTC,不经 WS
  meta: { width: number; height: number; codec: string } | null = null;
  readonly whepPath: string;

  private inner?: Scrcpy2Session;
  private rtsp?: RtspPublisher;
  private packetizer = new H264RtpPacketizer();
  private sps?: Buffer;
  private pps?: Buffer;
  private publishing = false;
  private publishStarting = false; // 发布握手互斥:握手未完成前禁止第二次 ANNOUNCE
  private publishGen = 0; // 发布代次:使在飞的旧握手作废
  private suppressAutoPublish = false; // 发布通道重建期:禁止旧采集端的帧触发发布
  private restarting = false;
  private suppressInnerClose = false;
  private lastIdrRestartAt = 0;
  private lastKeyframe: Buffer | null = null; // 最近的 IDR(供新观众即时起解)
  private closed = false;
  /* ---- 帧计数诊断(定位黑屏卡点) ---- */
  private dbgFrames = 0;
  private dbgKey = 0;
  private dbgSentPkts = 0;
  private dbgLastLog = 0;

  private constructor(instance: InstanceRow) {
    super();
    this.instance = instance;
    this.whepPath = `ra-${instance.id}`;
  }

  static async start(instance: InstanceRow): Promise<RtcSession> {
    const s = new RtcSession(instance);
    await s.bootstrap();
    return s;
  }

  private log(m: string): void {
    console.log(`[rtc:${this.instance.name}] ${m}`);
  }

  private async bootstrap(): Promise<void> {
    await this.startInner();
    this.emit('meta', this.meta);
    this.log('session ready');
  }

  /** 启动/重启采集端(scrcpy 2.4 三通道)。
   *  注意:await 之后必须检查 closed——会话可能在等待期间被关闭,
   *  否则会产生"僵尸会话"复活发布端,和正常会话互相顶线 */
  private async startInner(): Promise<void> {
    const inner = await Scrcpy2Session.start(this.instance);
    if (this.closed) {
      inner.close();
      return;
    }
    this.inner = inner;
    this.wireInner(inner);
  }

  /** 给采集端注册事件转发(视频帧→RTP,音频帧→WS,关闭→级联)。
   *  帧/meta 只认"当前"采集端:热切换瞬间旧采集端可能有在飞帧,
   *  不能让它们污染新会话的 SPS/PPS(否则新发布通道按旧尺寸协商,方向切换后花屏)。 */
  private wireInner(inner: Scrcpy2Session): void {
    this.meta = inner.meta ?? {
      width: this.instance.width, height: this.instance.height, codec: 'h264',
    };
    inner.on('meta', (m: { width: number; height: number; codec: string }) => {
      if (inner !== this.inner) return;
      this.meta = m;
      this.emit('meta', m);
    });
    inner.on('videoFrame', (f: { ptsAndFlags: bigint; payload: Buffer }) => this.onVideoFrame(inner, f));
    inner.on('audioFrame', (f: { pts: bigint; payload: Buffer }) => {
      if (inner !== this.inner) return;
      this.emit('audioFrame', f);
    });
    inner.on('closed', () => {
      if (this.suppressInnerClose) {
        this.suppressInnerClose = false; // restartCapture 主动关的,不连带关闭会话
        return;
      }
      this.close();
    });
  }

  /** 观众接入时的温和起解:距上次重启超过 cooldownMs 才热切换(产新 IDR)。
   *  与 PLI 无关的确定性机制——读者接入信号来自我们自己的控制 WS。
   *  注意:只做采集端热切换,不动发布通道(同路径换发布方在 MediaMTX 上不可靠)。 */
  restartIfIdle(cooldownMs = 5_000): void {
    if (this.closed || this.restarting) return;
    if (Date.now() - this.lastIdrRestartAt < cooldownMs) return;
    this.log('观众接入且长时间无新 IDR,热切换产新 IDR');
    void this.restartCapture();
  }

  /** 新观众接入/方向热重配:零间断热切换——
   *  先在后台把新采集端(新 lock 参数/新 IDR)起好,就绪后再替换旧的,
   *  替换前画面不断流,blip < 1s */
  async restartCapture(): Promise<void> {
    if (this.closed || this.restarting) return;
    this.restarting = true;
    this.log('热切换采集端');
    // 方向切换后旧 IDR 尺寸已失效,丢弃;同时压住 PLI 触发的二次重启
    this.lastKeyframe = null;
    this.lastIdrRestartAt = Date.now();
    try {
      // 1. 先起新采集端(旧的一直在播,用户无感)
      const newInner = await Scrcpy2Session.start(this.instance);
      if (this.closed) {
        newInner.close();
        return;
      }
      // 2. 就绪后替换:先接管事件,再关旧的(其 closed 事件被抑制,不级联)
      const old = this.inner;
      this.inner = newInner;
      this.wireInner(newInner);
      if (old && !old.isClosed) {
        this.suppressInnerClose = true;
        old.close();
      }
      // 3. 重启后若发布通道已死,顺带重建
      if (this.publishing && this.rtsp && !this.rtsp.isAlive()) {
        this.publishing = false;
      }
      // 方向重建期必须等新 config(新 SPS)到达再发布,不能用旧 SPS 抢跑
      if (!this.publishing && !this.suppressAutoPublish && this.sps && this.pps) {
        void this.startPublishing();
      }
    } catch (e) {
      this.log(`热切换失败: ${e instanceof Error ? e.message : e}`);
      // 失败不致命:inner 'closed' 事件兜底关闭会话,由上层重建
    } finally {
      this.restarting = false;
    }
  }

  private onVideoFrame(from: Scrcpy2Session, f: { ptsAndFlags: bigint; payload: Buffer }): void {
    if (this.closed || from !== this.inner) return; // 已关闭/旧采集端在飞帧一律丢弃
    const isConfig = (f.ptsAndFlags & CONFIG_FLAG) !== 0n;
    const isKey = (f.ptsAndFlags & KEYFRAME_FLAG) !== 0n;
    /* ---- 帧计数诊断 ---- */
    if (!isConfig) {
      this.dbgFrames++;
      if (isKey) this.dbgKey++;
      const now = Date.now();
      if (now - this.dbgLastLog > 10_000) {
        this.dbgLastLog = now;
        this.log(`dbg recv=${this.dbgFrames} key=${this.dbgKey} sentPkts=${this.dbgSentPkts} publishing=${this.publishing} rtspAlive=${this.rtsp?.isAlive() ?? false} sps=${!!this.sps}`);
      }
    }

    if (isConfig) {
      const { sps, pps } = extractSpsPps(f.payload);
      if (sps) this.sps = sps;
      if (pps) this.pps = pps;
      if (!this.publishing && this.sps && this.pps) {
        this.suppressAutoPublish = false; // 新 config 到达 = 采集端就绪,允许发布
        void this.startPublishing();
      }
      return; // SPS/PPS 由 SDP sprop 携带;RTP 侧在每个 IDR 前带内补发(见 sendFrame)
    }
    this.sendFrame(f.payload, isKey);
  }

  private async startPublishing(): Promise<void> {
    // 互斥:握手期间 publishing 尚未置真,没有这把锁,sendFrame 和 config 帧
    // 会并发触发多次 ANNOUNCE,发布端互相 "closing existing publisher" 顶到死
    if (this.closed || this.publishing || this.publishStarting) return;
    this.publishStarting = true;
    const gen = ++this.publishGen; // 代次递增,使在飞的旧握手作废
    const stale = () => this.closed || gen !== this.publishGen;
    const base = `${config.mediaMtxRtsp}/${this.whepPath}`;
    const rtsp = new RtspPublisher(base);
    try {
      await rtsp.connect();
      if (stale()) { rtsp.close(); return; }
      // MediaMTX 在 WebRTC 观众接入时会发 RTCP PLI/FIR 请求关键帧。
      // 新观众的解码器是全新状态:重放缓存的最近 IDR 与后续直播 P 帧天然同链
      // (等价于观众恰好在那帧 IDR 时接入),即时起解,无需重启采集。
      // 只有没有缓存 IDR 时才退化到重启采集(新会话必产 IDR)。
      rtsp.onRtcp = (_channel, payload) => {
        if (payload.length < 2) return;
        const pt = payload[1];
        const fmt = payload[0] & 0x1f;
        const isPli = pt === 205 && fmt === 1; // PSFB PLI
        const isFir = pt === 192;              // FIR(full intra request)
        if (!isPli && !isFir) return;
        if (this.lastKeyframe && this.publishing) {
          const ts = ptsToTs90(BigInt(Date.now()) * 1000n);
          for (const pkt of this.packetizer.packetize(this.lastKeyframe, ts)) {
            rtsp.sendInterleaved(0, pkt);
          }
          this.log(`收到 ${isPli ? 'PLI' : 'FIR'},已重放缓存 IDR(${(this.lastKeyframe.length / 1024).toFixed(1)}KB)`);
          return;
        }
        if (Date.now() - this.lastIdrRestartAt > 5_000) {
          this.lastIdrRestartAt = Date.now();
          this.log(`收到 ${isPli ? 'PLI' : 'FIR'} 且无缓存 IDR,重启采集`);
          void this.restartCapture();
        } else {
          this.log(`收到 ${isPli ? 'PLI' : 'FIR'} 但无缓存 IDR 且冷却中,忽略`);
        }
      };
      // SPS/PPS 由 SDP sprop 携带(实测 mediamtx 1.9.3 不会把 sprop 转发进 WHEP answer,
      // 浏览器解码另由前端 WebCodecs/兼容模式处理;profile-level-id 显式声明曾导致
      // mediamtx 收流后不分发,保持最小 fmtp 与 0.0.53 可用版本一致)
      const sdp = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=RemoteAndroid',
        'c=IN IP4 0.0.0.0',
        't=0 0',
        'm=video 0 RTP/AVP/TCP 96',
        'a=rtpmap:96 H264/90000',
        `a=fmtp:96 packetization-mode=1;sprop-parameter-sets=${this.sps!.toString('base64')},${this.pps!.toString('base64')}`,
        'a=control:trackID=0',
        '',
      ].join('\r\n');
      await rtsp.announce(sdp);
      if (stale()) { rtsp.close(); return; }
      await rtsp.setup(`${base}/trackID=0`);
      if (stale()) { rtsp.close(); return; }
      await rtsp.record();
      if (stale()) { rtsp.close(); return; }
      this.rtsp = rtsp;
      this.publishing = true;
      this.log(`RTSP 发布已建立 → ${base}`);
    } catch (e) {
      rtsp.close();
      this.log(`RTSP 发布失败(5s 后重试): ${e instanceof Error ? e.message : e}`);
      setTimeout(() => {
        if (!this.closed && !this.publishing) void this.startPublishing();
      }, 5_000);
    } finally {
      this.publishStarting = false;
    }
  }

  /** 时间戳统一用墙钟;发布通道死了就在下一帧自愈重建 */
  private sendFrame(annexb: Buffer, isKey: boolean): void {
    // 缓存最近的 IDR:PLI 重放/新观众起解都靠它(之前只清不存,导致晚到观众永久黑屏)
    if (isKey) this.lastKeyframe = Buffer.from(annexb);
    if (this.publishing && this.rtsp && !this.rtsp.isAlive()) {
      this.publishing = false;
      this.log('发布通道已断,下一帧触发重建');
    }
    if (!this.publishing && !this.suppressAutoPublish && this.sps && this.pps) {
      void this.startPublishing();
      return;
    }
    if (!this.publishing || !this.rtsp) return;
    const ts = ptsToTs90(BigInt(Date.now()) * 1000n);
    for (const pkt of this.packetizer.packetize(annexb, ts)) {
      this.dbgSentPkts++;
      this.rtsp.sendInterleaved(0, pkt);
    }
  }

  dispatchControl(msg: ClientMsg): void {
    this.inner?.dispatchControl(msg);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.log('session close()');
    this.rtsp?.close();
    this.inner?.close();
    this.emit('closed');
  }
}
