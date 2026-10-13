import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import { instanceStore, userStore } from './db';
import { canAccess, verifyToken } from './auth';
import { acquire, release, StreamMode } from './sessions';
import { parseClientMsg } from './control';

/* ---------------- WebSocket 网关 ----------------
 * /ws/stream/:id?token=<jwt>&mode=ws   视频流(v1 帧) + 触控指令
 * /ws/stream/:id?token=<jwt>&mode=v2   视频流 + PCM 音频流 + 触控指令(推荐)
 * /ws/stream/:id?token=<jwt>&mode=rtc  仅触控指令(视频/音频走 MediaMTX WHEP,实验性)
 * ------------------------------------------------ */

export const wss = new WebSocketServer({ noServer: true });

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const m = url.pathname.match(/^\/ws\/stream\/([\w-]+)$/);
  if (!m) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const payload = verifyToken(url.searchParams.get('token') ?? '');
  const user = payload ? userStore.get(payload.uid) : undefined;
  const instance = instanceStore.get(m[1]);
  if (!user || !instance || !canAccess(user, instance.ownerId)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const modeParam = url.searchParams.get('mode');
  const mode: StreamMode = modeParam === 'rtc' ? 'rtc' : modeParam === 'v2' ? 'v2' : 'ws';

  wss.handleUpgrade(req, socket, head, async (ws) => {
    let entry;
    try {
      entry = await acquire(instance, mode, ws);
    } catch (e) {
      ws.close(1011, `stream unavailable: ${e instanceof Error ? e.message : e}`);
      return;
    }

    // 视频元信息(前端据此初始化画布/坐标系);v2 的 meta 是异步解析的,注册一次性兜底
    const meta = entry.session.meta;
    if (meta) ws.send(JSON.stringify({ type: 'meta', ...meta }));
    else {
      entry.session.once('meta', (mm: { width: number; height: number; codec: string }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'meta', ...mm }));
      });
    }

    ws.on('message', (data) => {
      const msg = parseClientMsg(data);
      if (!msg) return;
      try {
        entry.session.dispatchControl(msg);
      } catch {
        /* 单条指令失败不断流 */
      }
    });

    ws.on('close', () => release(instance.id, mode, ws));
    ws.on('error', () => release(instance.id, mode, ws));
  });
}
