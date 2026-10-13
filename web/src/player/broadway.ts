/**
 * Broadway 兜底解码器:HTTP 等非安全上下文下 WebCodecs 不可用时,
 * 用 WASM 软解 H264(ws-scrcpy 同款方案),720p 级别 CPU 可承受。
 */
import { Player } from 'broadway-player';
import type { ParsedFrame } from './h264';

export class BroadwaySink {
  private player: { decode: (data: Uint8Array) => void; canvas: HTMLCanvasElement };
  readonly canvas: HTMLCanvasElement;

  constructor(width: number, height: number) {
    this.player = new Player({
      useWorker: false, // worker 模式要额外配 worker 文件,非安全上下文直接主线程
      webgl: 'auto',
      size: { width, height },
    });
    this.canvas = this.player.canvas;
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;z-index:0;';
  }

  /** 直接喂 AnnexB 帧(config 帧含 SPS/PPS 也照常喂,broadway 自己处理) */
  decode(frame: ParsedFrame): void {
    this.player.decode(new Uint8Array(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength));
  }

  destroy(): void {
    this.canvas.remove();
  }
}

/** 当前环境是否可用 WebCodecs(HTTP 局域网访问不算安全上下文,会不可用) */
export const hasWebCodecs = typeof window !== 'undefined' && 'VideoDecoder' in window;
