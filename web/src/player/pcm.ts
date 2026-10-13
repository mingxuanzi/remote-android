/**
 * PCM 播放器(双路径):
 *  - 安全上下文(HTTPS/localhost):AudioWorklet 低延迟播放
 *  - HTTP 非安全上下文:ScriptProcessorNode + 主线程环形缓冲
 * 输入:PCM s16le 48kHz 立体声;积压超过 0.4s 自动丢旧保延迟。
 */

const WORKLET_CODE = `
class RaPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 48000 * 2 * 2;
    this.buf = new Int16Array(this.size);
    this.w = 0; this.r = 0;
    this.port.onmessage = (e) => {
      const d = new Int16Array(e.data);
      for (let i = 0; i < d.length; i++) { this.buf[this.w] = d[i]; this.w = (this.w + 1) % this.size; }
      const used = (this.w - this.r + this.size) % this.size;
      const cap = Math.floor(this.size * 0.2);
      if (used > cap) this.r = (this.w - cap + this.size) % this.size;
    };
  }
  process(_, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    for (let i = 0; i < L.length; i++) {
      const used = (this.w - this.r + this.size) % this.size;
      if (used >= 2) {
        L[i] = this.buf[this.r] / 32768; this.r = (this.r + 1) % this.size;
        R[i] = this.buf[this.r] / 32768; this.r = (this.r + 1) % this.size;
      } else { L[i] = 0; R[i] = 0; }
    }
    return true;
  }
}
registerProcessor('ra-pcm', RaPcm);
`;

export class PcmPlayer {
  on = true;
  private ctx: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sp: ScriptProcessorNode | null = null;
  private ring = { buf: new Int16Array(48000 * 2 * 2), w: 0, r: 0 };

  async init(): Promise<void> {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext({ sampleRate: 48000 });
      if (this.ctx.audioWorklet) {
        const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
        await this.ctx.audioWorklet.addModule(URL.createObjectURL(blob));
        this.worklet = new AudioWorkletNode(this.ctx, 'ra-pcm', { numberOfInputs: 0, outputChannelCount: [2] });
        this.worklet.connect(this.ctx.destination);
      } else {
        this.sp = this.ctx.createScriptProcessor(4096, 0, 2);
        this.sp.onaudioprocess = (e) => {
          const L = e.outputBuffer.getChannelData(0);
          const R = e.outputBuffer.numberOfChannels > 1 ? e.outputBuffer.getChannelData(1) : L;
          const ring = this.ring;
          for (let i = 0; i < L.length; i++) {
            const used = (ring.w - ring.r + ring.buf.length) % ring.buf.length;
            if (used >= 2) {
              L[i] = ring.buf[ring.r] / 32768; ring.r = (ring.r + 1) % ring.buf.length;
              R[i] = ring.buf[ring.r] / 32768; ring.r = (ring.r + 1) % ring.buf.length;
            } else { L[i] = 0; R[i] = 0; }
          }
        };
        this.sp.connect(this.ctx.destination);
      }
    } catch (e) {
      console.warn('PCM 音频初始化失败(仅视频):', e);
    }
  }

  feed(payload: Uint8Array): void {
    if (!this.on) return;
    if (this.worklet) {
      const copy = payload.slice().buffer;
      this.worklet.port.postMessage(copy, [copy]);
    } else if (this.sp) {
      const d = new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength >> 1);
      const ring = this.ring;
      for (let i = 0; i < d.length; i++) { ring.buf[ring.w] = d[i]; ring.w = (ring.w + 1) % ring.buf.length; }
      const used = (ring.w - ring.r + ring.buf.length) % ring.buf.length;
      const cap = Math.floor(ring.buf.length * 0.2);
      if (used > cap) ring.r = (ring.w - cap + ring.buf.length) % ring.buf.length;
    }
  }

  toggle(): void {
    this.on = !this.on;
    if (this.on && this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  /** 对齐用户意图:取消静音→开声(顺带 resume),静音→无声 */
  setOn(on: boolean): void {
    if (this.on !== on) this.toggle();
  }

  dispose(): void {
    this.sp?.disconnect();
    void this.ctx?.close();
  }
}
