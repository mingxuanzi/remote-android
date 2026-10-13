/**
 * 视频 GOP 回放缓冲:scrcpy 的 H264 配置包(SPS/PPS)只在流开始时发送一次,
 * 其后第一个 IDR 与配置包之间的帧构成一个 GOP。
 *
 * 会话 bootstrap 期间(视频 socket 已推流但 wireEntry/观众尚未就位)以及
 * 晚进观众接入时,若直接转发会丢掉"配置+首个 IDR",前端解码器
 * (H264Decoder 未配置前丢弃一切帧 / broadway 同样起解不了)就永久黑屏。
 * 因此在会话内部从第一帧开始滚动保留"最新配置 + 最近一个 GOP",
 * 新观众入场时先回放这些帧,保证起解即有图。
 */

export const CONFIG_FLAG = 1n << 63n; // 配置包(SPS/PPS)
export const KEYFRAME_FLAG = 1n << 62n; // IDR 关键帧

export interface ReplayFrame {
  ptsAndFlags: bigint;
  payload: Buffer;
}

export class VideoReplay {
  private configFrame: ReplayFrame | null = null;
  private gop: ReplayFrame[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes = 4 * 1024 * 1024) {}

  /** 记录一帧(与 wire 协议无关,仅 pts+负载);按 config/keyframe 标志滚动维护 */
  push(ptsAndFlags: bigint, payload: Buffer): void {
    if ((ptsAndFlags & CONFIG_FLAG) !== 0n) {
      this.configFrame = { ptsAndFlags, payload };
      this.gop = [];
      this.bytes = 0;
      return;
    }
    if ((ptsAndFlags & KEYFRAME_FLAG) !== 0n) {
      this.gop = [{ ptsAndFlags, payload }];
      this.bytes = payload.length;
      return;
    }
    this.gop.push({ ptsAndFlags, payload });
    this.bytes += payload.length;
    // GOP 异常巨大时丢最旧帧兜底(正常情况下一个 GOP 远小于上限)
    while (this.bytes > this.maxBytes) this.bytes -= this.gop.shift()!.payload.length;
  }

  /** 新观众入场应回放的帧:最新配置包 + 最近一个 GOP */
  frames(): ReplayFrame[] {
    return this.configFrame ? [this.configFrame, ...this.gop] : [...this.gop];
  }
}
