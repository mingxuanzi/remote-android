import { RawData } from 'ws';

/** 前端上行控制指令(与协议版本无关) */
export interface TouchMsg { t: 'touch'; action: number; id?: number; x: number; y: number; }
export interface KeyMsg { t: 'key'; action: number; keycode: number; meta?: number; }
export interface TextMsg { t: 'text'; text: string; }
export interface ScrollMsg { t: 'scroll'; x: number; y: number; hScroll?: number; vScroll?: number; }
export type ClientMsg = TouchMsg | KeyMsg | TextMsg | ScrollMsg;

/** 推流会话统一接口:WS v1(1.x)/ WS v2(2.x 带音频)/ WebRTC 模式都实现它 */
export interface StreamSession {
  readonly instance: { id: string; name: string; width: number; height: number };
  meta: { width: number; height: number; codec: string } | null;
  readonly isClosed: boolean;
  /** 编码并下发一条控制指令 */
  dispatchControl(msg: ClientMsg): void;
  close(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, listener: (...args: any[]) => void): this;
  /** WS 模式才有视频帧(RTC 模式视频走 MediaMTX) */
  readonly hasVideoFrames: boolean;
}

/* ---------------- scrcpy 1.25 控制协议 ----------------
 * KEYCODE(0):  type(1) action(1) keycode(4) repeat(4) metaState(4)      = 14B
 * TEXT(1):     type(1) len(2) utf8
 * TOUCH(2):    type(1) action(1) pointerId(8) x(4) y(4) w(2) h(2) pressure(2) buttons(4) = 28B
 * SCROLL(3):   type(1) x(4) y(4) w(2) h(2) hScroll(4) vScroll(4)        = 21B (i32)
 * ------------------------------------------------------ */

export function encodeV1(msg: ClientMsg, w: number, h: number): Buffer | null {
  switch (msg.t) {
    case 'touch': {
      const buf = Buffer.alloc(28);
      buf.writeUInt8(2, 0);
      buf.writeUInt8(msg.action, 1);
      buf.writeBigUInt64BE(BigInt(msg.id ?? 0), 2);
      buf.writeUInt32BE(Math.round(msg.x), 10);
      buf.writeUInt32BE(Math.round(msg.y), 14);
      buf.writeUInt16BE(w, 18);
      buf.writeUInt16BE(h, 20);
      buf.writeUInt16BE(msg.action === 1 ? 0 : 0xffff, 22); // pressure u16 定点
      buf.writeUInt32BE(0, 24);
      return buf;
    }
    case 'key': {
      const buf = Buffer.alloc(14);
      buf.writeUInt8(0, 0);
      buf.writeUInt8(msg.action, 1);
      buf.writeUInt32BE(msg.keycode, 2);
      buf.writeUInt32BE(0, 6);
      buf.writeUInt32BE(msg.meta ?? 0, 10);
      return buf;
    }
    case 'text': {
      const text = Buffer.from(msg.text, 'utf8');
      const buf = Buffer.alloc(3 + text.length);
      buf.writeUInt8(1, 0);
      buf.writeUInt16BE(text.length, 1);
      text.copy(buf, 3);
      return buf;
    }
    case 'scroll': {
      const buf = Buffer.alloc(21);
      buf.writeUInt8(3, 0);
      buf.writeUInt32BE(Math.round(msg.x), 1);
      buf.writeUInt32BE(Math.round(msg.y), 5);
      buf.writeUInt16BE(w, 9);
      buf.writeUInt16BE(h, 11);
      buf.writeInt32BE(msg.hScroll ?? 0, 13);
      buf.writeInt32BE(msg.vScroll ?? 0, 17);
      return buf;
    }
  }
}

/* ---------------- scrcpy 2.4 控制协议 ----------------
 * KEYCODE(0):  type(1) action(1) keycode(4) repeat(4) metaState(4)      = 14B(同 1.x)
 * TEXT(1):     type(1) len(2) utf8                                       (同 1.x)
 * TOUCH(2):    type(1) action(1) pointerId(8) x(4) y(4) w(2) h(2) pressure(2)
 *              actionButton(4) buttons(4)                                = 32B
 * SCROLL(3):   type(1) x(4) y(4) w(2) h(2) hScroll(2) vScroll(2) buttons(4) = 21B
 *              ※ 滚动量是 i16 定点(1.0 = 32768),不是 1.x 的 i32
 * ------------------------------------------------------ */

const clampI16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32768)));

export function encodeV2(msg: ClientMsg, w: number, h: number): Buffer | null {
  switch (msg.t) {
    case 'touch': {
      const buf = Buffer.alloc(32);
      buf.writeUInt8(2, 0);
      buf.writeUInt8(msg.action, 1);
      buf.writeBigUInt64BE(BigInt(msg.id ?? 0), 2);
      buf.writeUInt32BE(Math.round(msg.x), 10);
      buf.writeUInt32BE(Math.round(msg.y), 14);
      buf.writeUInt16BE(w, 18);
      buf.writeUInt16BE(h, 20);
      buf.writeUInt16BE(msg.action === 1 ? 0 : 0xffff, 22);
      buf.writeUInt32BE(0, 24); // actionButton
      buf.writeUInt32BE(0, 28); // buttons
      return buf;
    }
    case 'scroll': {
      const buf = Buffer.alloc(21);
      buf.writeUInt8(3, 0);
      buf.writeUInt32BE(Math.round(msg.x), 1);
      buf.writeUInt32BE(Math.round(msg.y), 5);
      buf.writeUInt16BE(w, 9);
      buf.writeUInt16BE(h, 11);
      buf.writeInt16BE(clampI16(msg.hScroll ?? 0), 13);
      buf.writeInt16BE(clampI16(msg.vScroll ?? 0), 15);
      buf.writeUInt32BE(0, 17); // buttons
      return buf;
    }
    default:
      return encodeV1(msg, w, h); // key/text 与 1.x 一致
  }
}

export function parseClientMsg(data: RawData): ClientMsg | null {
  try {
    const m = JSON.parse(data.toString());
    if (m && typeof m.t === 'string') return m as ClientMsg;
  } catch {
    /* 忽略非 JSON */
  }
  return null;
}
