/**
 * H264 工具:scrcpy 输出 AnnexB 码流(start code 分隔 NALU),
 * WebCodecs VideoDecoder('avc') 需要 length-prefixed(AVCC)格式 + avcC description。
 */

const CONFIG_FLAG = 1n << 63n;
const KEYFRAME_FLAG = 1n << 62n;
const PTS_MASK = ~(CONFIG_FLAG | KEYFRAME_FLAG);

export interface ParsedFrame {
  config: boolean;
  keyframe: boolean;
  /** 微秒 */
  pts: number;
  payload: Uint8Array;
}

/** 解析后端转发的帧: [ptsAndFlags 8B][size 4B][payload] */
export function parseWireFrame(buf: ArrayBuffer): ParsedFrame {
  const dv = new DataView(buf);
  const ptsAndFlags = dv.getBigUint64(0);
  const size = dv.getUint32(8);
  return {
    config: (ptsAndFlags & CONFIG_FLAG) !== 0n,
    keyframe: (ptsAndFlags & KEYFRAME_FLAG) !== 0n,
    pts: Number(ptsAndFlags & PTS_MASK),
    payload: new Uint8Array(buf, 12, size),
  };
}

/** AnnexB 拆 NALU */
export function splitNalus(data: Uint8Array): Uint8Array[] {
  const nalus: Uint8Array[] = [];
  let i = 0;
  const n = data.length;
  let start = -1;
  while (i < n - 3) {
    const is3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    const is4 = !is3 && i < n - 4 && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;
    if (is3 || is4) {
      if (start >= 0 && start < i) nalus.push(data.subarray(start, i));
      i += is4 ? 4 : 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < n) nalus.push(data.subarray(start, n));
  return nalus;
}

/** 由 SPS/PPS 构建 avcC description */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length);
  let o = 0;
  out[o++] = 1;                    // configurationVersion
  out[o++] = sps[1];               // AVCProfileIndication
  out[o++] = sps[2];               // profile_compatibility
  out[o++] = sps[3];               // AVCLevelIndication
  out[o++] = 0xff;                 // 6bit reserved + lengthSizeMinusOne=3(4字节长度前缀)
  out[o++] = 0xe1;                 // 3bit reserved + numOfSPS=1
  out[o++] = sps.length >> 8;
  out[o++] = sps.length & 0xff;
  out.set(sps, o); o += sps.length;
  out[o++] = 1;                    // numOfPPS
  out[o++] = pps.length >> 8;
  out[o++] = pps.length & 0xff;
  out.set(pps, o);
  return out;
}

/** AnnexB 帧 → AVCC(4 字节大端长度前缀) */
export function annexbToAvcc(nalus: Uint8Array[]): Uint8Array {
  const total = nalus.reduce((s, x) => s + 4 + x.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const nalu of nalus) {
    dv.setUint32(o, nalu.length);
    out.set(nalu, o + 4);
    o += 4 + nalu.length;
  }
  return out;
}

/** 从 SPS 生成 codec 字符串(如 avc1.640028) */
export function codecStringFromSps(sps: Uint8Array): string {
  const hex = (b: number) => b.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

/** 封装的 WebCodecs 解码器:配置包(SPS/PPS)到达后自动 configure */
export class H264Decoder {
  private decoder: VideoDecoder | null = null;
  private configured = false;
  onFrame: ((frame: VideoFrame) => void) | null = null;

  private ensure(): VideoDecoder {
    if (!this.decoder) {
      this.decoder = new VideoDecoder({
        output: (frame) => this.onFrame?.(frame),
        error: (e) => console.error('VideoDecoder error:', e),
      });
    }
    return this.decoder;
  }

  handleConfig(payload: Uint8Array): void {
    const nalus = splitNalus(payload);
    const sps = nalus.find((n) => (n[0] & 0x1f) === 7);
    const pps = nalus.find((n) => (n[0] & 0x1f) === 8);
    if (!sps || !pps) return;
    const description = buildAvcC(sps, pps);
    this.ensure().configure({
      codec: codecStringFromSps(sps),
      description,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware',
    });
    this.configured = true;
  }

  decode(frame: ParsedFrame): void {
    if (frame.config) {
      this.handleConfig(frame.payload);
      return;
    }
    if (!this.configured) return;
    const data = annexbToAvcc(splitNalus(frame.payload));
    this.ensure().decode(
      new EncodedVideoChunk({ type: frame.keyframe ? 'key' : 'delta', timestamp: frame.pts, data }),
    );
  }

  destroy(): void {
    try {
      this.decoder?.close();
    } catch { /* 已关闭 */ }
    this.decoder = null;
    this.configured = false;
  }
}
