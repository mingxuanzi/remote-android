import { WebSocket } from 'ws';
import { ScrcpySession, frameToWire } from './scrcpy';
import { Scrcpy2Session } from './scrcpy2';
import { RtcSession } from './rtc';
import { InstanceRow } from './db';
import { StreamSession } from './control';

/** ws = scrcpy 1.25(仅视频);v2 = scrcpy 2.4(视频+PCM 音频);rtc = WebRTC(视频走 MediaMTX) */
export type StreamMode = 'ws' | 'v2' | 'rtc';

export interface Pooled {
  session: StreamSession;
  mode: StreamMode;
  viewers: Set<WebSocket>;
  idleTimer?: NodeJS.Timeout;
}

/** 会话池:key = <instanceId>:<mode>,同实例同模式多个浏览器共享一路 */
const pool = new Map<string, Pooled>();
/** 启动去重:同 key 的并发 acquire 共享同一个 starting Promise,
 *  防止并发创建多个会话(scrcpy abstract socket 同名会互相顶掉) */
const pending = new Map<string, Promise<Pooled>>();

const keyOf = (id: string, mode: StreamMode) => `${id}:${mode}`;

async function createSession(instance: InstanceRow, mode: StreamMode): Promise<StreamSession> {
  if (mode === 'rtc') return RtcSession.start(instance);
  if (mode === 'v2') return Scrcpy2Session.start(instance);
  return ScrcpySession.start(instance);
}

/** 打包一帧:[channel 1B][ptsAndFlags 8B][size 4B][payload] */
function wireFrame(channel: number, ptsAndFlags: bigint, payload: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt8(channel, 0);
  header.writeBigUInt64BE(ptsAndFlags, 1);
  header.writeUInt32BE(payload.length, 9);
  return Buffer.concat([header, payload]);
}

function broadcast(entry: Pooled, data: Buffer | string): void {
  for (const v of entry.viewers) {
    if (v.readyState === WebSocket.OPEN) v.send(data);
  }
}

function wireEntry(key: string, instance: InstanceRow, mode: StreamMode, session: StreamSession): Pooled {
  const entry: Pooled = { session, mode, viewers: new Set() };

  session.on('closed', () => {
    for (const v of entry.viewers) v.close(1011, 'stream closed');
    pool.delete(key);
  });
  session.on('serverLog', (line: string) => console.warn(`[${mode}:${instance.name}] ${line.trim()}`));
  // v2 的 meta 是异步解析出来的(codecMeta),要转发给所有观众
  // 注意:必须发文本帧,二进制帧会被前端当视频帧解析(帧长正好撞上 "meta" ASCII)
  session.on('meta', (meta: { width: number; height: number; codec: string }) => {
    broadcast(entry, JSON.stringify({ type: 'meta', ...meta }));
  });

  if (session instanceof ScrcpySession) {
    // v1:channel 0 = 视频(帧头不带 channel 前缀,兼容旧前端解析)
    session.on('frame', (frame: { ptsAndFlags: bigint; payload: Buffer }) => {
      const header = Buffer.alloc(12);
      header.writeBigUInt64BE(frame.ptsAndFlags, 0);
      header.writeUInt32BE(frame.payload.length, 8);
      broadcast(entry, Buffer.concat([header, frame.payload]));
    });
  } else if (session instanceof Scrcpy2Session) {
    // v2:channel 1 = 视频,channel 2 = 音频(PCM s16le 48kHz 立体声)
    session.on('videoFrame', (frame: { ptsAndFlags: bigint; payload: Buffer }) => {
      broadcast(entry, wireFrame(1, frame.ptsAndFlags, frame.payload));
    });
    session.on('audioFrame', (frame: { pts: bigint; payload: Buffer }) => {
      broadcast(entry, wireFrame(2, frame.pts, frame.payload));
    });
  } else if (session instanceof RtcSession) {
    // rtc:视频走 WebRTC,音频仍经 WS 下发(channel 2)
    session.on('audioFrame', (frame: { pts: bigint; payload: Buffer }) => {
      broadcast(entry, wireFrame(2, frame.pts, frame.payload));
    });
  }
  return entry;
}

export async function acquire(instance: InstanceRow, mode: StreamMode, viewer?: WebSocket): Promise<Pooled> {
  const key = keyOf(instance.id, mode);
  let entry = pool.get(key);
  const reused = !!entry && !entry.session.isClosed;

  if (!entry || entry.session.isClosed) {
    let startPromise = pending.get(key);
    if (!startPromise) {
      startPromise = (async () => {
        const session = await createSession(instance, mode);
        const e = wireEntry(key, instance, mode, session);
        pool.set(key, e);
        return e;
      })();
      pending.set(key, startPromise);
      startPromise
        .finally(() => pending.delete(key))
        .catch(() => void 0);
    }
    entry = await startPromise; // 并发 acquire 在此汇合,同 key 只会启动一次
  }

  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  if (viewer) {
    // 新观众先回放"配置包+最近一个 GOP"再进直播:
    // scrcpy 的配置包只在流开始发一次,且 redroid 编码器不产周期 IDR,
    // bootstrap 期间(视频已推流但观众未就位)丢掉的"配置+首个 IDR"无法自然恢复 → 黑屏
    if (entry.session.hasVideoFrames) {
      for (const f of entry.session.videoReplay.frames()) {
        if (viewer.readyState !== WebSocket.OPEN) break;
        const packet = mode === 'v2' ? wireFrame(1, f.ptsAndFlags, f.payload) : frameToWire(f);
        viewer.send(packet);
      }
    }
    entry.viewers.add(viewer);
    // rtc:观众(重)接入且距上次重启已久 → 热切换产新 IDR(读者起解的确定性信号;
    // 冷却期内不触发,避免和方向切换的热重启撞车)
    if (mode === 'rtc' && entry.session instanceof RtcSession) {
      (entry.session as RtcSession).restartIfIdle(5_000);
    }
  }
  return entry;
}

/** 仅确保会话已启动(REST 预热 WebRTC 会话用) */
export async function ensure(instance: InstanceRow, mode: StreamMode): Promise<Pooled> {
  return acquire(instance, mode);
}

export function release(instanceId: string, mode: StreamMode, viewer: WebSocket): void {
  const key = keyOf(instanceId, mode);
  const entry = pool.get(key);
  if (!entry) return;
  entry.viewers.delete(viewer);
  if (entry.viewers.size === 0) {
    // 观众归零后空闲回收,避免频繁重建会话
    entry.idleTimer = setTimeout(() => {
      entry.session.close();
      pool.delete(key);
    }, 60_000);
  }
}

/** 实例停止/删除时清理其所有会话 */
export function destroyForInstance(instanceId: string): void {
  for (const mode of ['ws', 'v2', 'rtc'] as StreamMode[]) {
    const key = keyOf(instanceId, mode);
    const entry = pool.get(key);
    if (entry) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.session.close();
      pool.delete(key);
    }
  }
}

/** 方向模式热重配:把新参数灌进存活会话并关闭它,前端播放器重挂载后按新参数重建。
 *  - 实测 MediaMTX 对"同路径换发布方"(关旧 RTSP + 重新 ANNOUNCE)支持不可靠:
 *    换方后路径字节计数停滞,新观众零数据,因此方向变更走"销毁重建"而非热切换,
 *    反正前端按 key 重挂载本来就会新建会话,黑屏期 = 重建耗时(2~4s),有 loading 遮罩 */
export async function reconfigureInstance(row: InstanceRow): Promise<void> {
  for (const mode of ['ws', 'v2', 'rtc'] as StreamMode[]) {
    const key = keyOf(row.id, mode);
    const entry = pool.get(key);
    if (!entry) continue;
    // 会话持有的是创建时的 InstanceRow 对象,改方向字段供后续重建使用
    (entry.session as unknown as { instance: InstanceRow }).instance.orientation = row.orientation;
    entry.session.close();
  }
}
