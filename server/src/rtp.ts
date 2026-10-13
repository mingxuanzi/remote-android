/**
 * H264 AnnexB → RTP(RFC 6184)打包器:single NAL / FU-A 分片。
 */

/** 按 start code 拆 NALU(与前端 splitNalus 同构) */
export function splitNalus(data: Buffer): Buffer[] {
  const nalus: Buffer[] = [];
  let i = 0;
  const n = data.length;
  let start = -1;
  while (i < n - 3) {
    const is3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    const is4 = !is3 && i < n - 4 && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;
    if (is3 || is4) {
      if (start >= 0 && start < i) nalus.push(Buffer.from(data.subarray(start, i)));
      i += is4 ? 4 : 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < n) nalus.push(Buffer.from(data.subarray(start, n)));
  return nalus;
}

const MAX_RTP_PAYLOAD = 1400;

export class H264RtpPacketizer {
  private seq = 0;
  private ssrc = (Math.random() * 0xffffffff) >>> 0;
  readonly payloadType = 96;

  /** 打包一帧(AnnexB,可含多个 NALU),ts90 为 90kHz 时间戳 */
  packetize(annexb: Buffer, ts90: number): Buffer[] {
    const packets: Buffer[] = [];
    const nalus = splitNalus(annexb).filter((x) => x.length > 0);
    for (let ni = 0; ni < nalus.length; ni++) {
      const nalu = nalus[ni];
      const isLastNalu = ni === nalus.length - 1;
      if (nalu.length <= MAX_RTP_PAYLOAD) {
        packets.push(this.makePacket(nalu, ts90, isLastNalu));
      } else {
        // FU-A 分片
        const header = nalu[0];
        const nri = header & 0x60;
        const nalType = header & 0x1f;
        let offset = 1;
        while (offset < nalu.length) {
          const chunkLen = Math.min(MAX_RTP_PAYLOAD - 2, nalu.length - offset);
          const isStart = offset === 1;
          const isEnd = offset + chunkLen === nalu.length;
          const fuIndicator = nri | 28; // FU-A
          const fuHeader = (isStart ? 0x80 : 0) | (isEnd ? 0x40 : 0) | nalType;
          const payload = Buffer.concat([
            Buffer.from([fuIndicator, fuHeader]),
            nalu.subarray(offset, offset + chunkLen),
          ]);
          packets.push(this.makePacket(payload, ts90, isLastNalu && isEnd));
          offset += chunkLen;
        }
      }
    }
    return packets;
  }

  private makePacket(payload: Buffer, ts90: number, marker: boolean): Buffer {
    const pkt = Buffer.alloc(12 + payload.length);
    pkt[0] = 0x80; // V=2
    pkt[1] = (marker ? 0x80 : 0) | this.payloadType;
    pkt.writeUInt16BE(this.seq & 0xffff, 2);
    this.seq = (this.seq + 1) & 0xffff;
    pkt.writeUInt32BE(ts90 >>> 0, 4);
    pkt.writeUInt32BE(this.ssrc, 8);
    payload.copy(pkt, 12);
    return pkt;
  }
}

/** μs → 90kHz RTP 时间戳 */
export function ptsToTs90(ptsUs: bigint | number): number {
  return Number((BigInt(ptsUs) * 9n) / 100n) >>> 0;
}

/** 从 AnnexB 中提取 SPS/PPS(供 SDP sprop-parameter-sets 使用) */
export function extractSpsPps(annexb: Buffer): { sps?: Buffer; pps?: Buffer } {
  const out: { sps?: Buffer; pps?: Buffer } = {};
  for (const nalu of splitNalus(annexb)) {
    if (!nalu.length) continue;
    const t = nalu[0] & 0x1f;
    if (t === 7 && !out.sps) out.sps = nalu;
    if (t === 8 && !out.pps) out.pps = nalu;
  }
  return out;
}
