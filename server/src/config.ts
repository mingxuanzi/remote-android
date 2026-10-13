import fs from 'node:fs';
import path from 'node:path';

/** 读取/生成 JWT 密钥:优先环境变量,否则生成并持久化到数据目录(重启不丢) */
function loadJwtSecret(dbPath: string): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secretFile = path.join(path.dirname(dbPath), '.jwt-secret');
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* 不存在则生成 */
  }
  const generated = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  } catch {
    /* 写不进则仅用本次内存值 */
  }
  return generated;
}

const dbPath = process.env.DB_PATH ?? path.resolve(process.cwd(), 'data/remote-android.db');

export const config = {
  /** HTTP/WS 监听端口 */
  port: Number(process.env.PORT ?? 8080),
  /** Docker 套接字:Linux 默认 /var/run/docker.sock;Windows Docker Desktop 用 npipe:////./pipe/docker_engine */
  dockerSocket: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
  /** redroid 实例接入的 Docker 网络(api 直连实例 adb 用) */
  dockerNetwork: process.env.DOCKER_NETWORK ?? 'remote-android-net',
  /** 默认 redroid 镜像,创建实例时可被覆盖 */
  redroidImage: process.env.REDROID_IMAGE ?? 'redroid/redroid:12.0.0-latest',
  /** 实例 DNS(redroid 容器无 /etc/resolv.conf,必须显式指定) */
  redroidDns1: process.env.REDROID_DNS1 ?? '223.5.5.5',
  redroidDns2: process.env.REDROID_DNS2 ?? '223.6.6.6',
  /** host 渲染模式挂载的 GPU 设备 */
  gpuDevice: process.env.GPU_DEVICE ?? '/dev/dri',
  /** scrcpy-server.jar 本地路径(push 到实例 /data/local/tmp) */
  scrcpyServerPath: process.env.SCRCPY_SERVER_PATH ?? path.resolve(process.cwd(), 'assets/scrcpy-server.jar'),
  /** scrcpy-server 版本(协议握手参数) */
  scrcpyVersion: process.env.SCRCPY_VERSION ?? '1.25',
  /** WebRTC 链路用的 scrcpy-server 2.x(带音频 socket) */
  scrcpy2ServerPath: process.env.SCRCPY2_SERVER_PATH ?? path.resolve(process.cwd(), 'assets/scrcpy-server-2.4.jar'),
  scrcpy2Version: process.env.SCRCPY2_VERSION ?? '2.4',
  /** MediaMTX RTSP 推流入口(api 容器内网可达) */
  mediaMtxRtsp: process.env.MTX_RTSP ?? 'rtsp://mediamtx:8554',
  /** 推流默认码率(bps)/帧率 */
  scrcpyBitrate: Number(process.env.SCRCPY_BITRATE ?? 8_000_000),
  scrcpyFps: Number(process.env.SCRCPY_FPS ?? 30),
  /** SQLite 台账文件 */
  dbPath,
  /** JWT 签名密钥 */
  jwtSecret: loadJwtSecret(dbPath),
};
