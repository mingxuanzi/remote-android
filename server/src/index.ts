import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { config } from './config';
import { initDb, instanceStore } from './db';
import { ensureNetwork, inspectState, reconcileStatus } from './docker';
import { router, ensureAdminUser } from './routes';
import { handleUpgrade } from './ws';

initDb();
ensureAdminUser();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/api', router);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
server.on('upgrade', handleUpgrade);

/** 台账状态周期对账(容器被外部操作时保持页面状态正确) */
async function reconcile(): Promise<void> {
  for (const row of instanceStore.list()) {
    const state = await inspectState(row.name);
    const next = reconcileStatus(row.status, state);
    if (next) {
      instanceStore.setStatus(row.id, next, next === 'error' ? '容器不存在' : '');
    }
  }
}

async function main(): Promise<void> {
  await ensureNetwork().catch((e) => console.warn('创建 Docker 网络失败(可忽略,稍后自动重试):', e));
  setInterval(() => void reconcile().catch(() => void 0), 5_000);

  server.listen(config.port, () => {
    console.log(`RemoteAndroid API listening on :${config.port}`);
    console.log(`redroid 镜像: ${config.redroidImage} | GPU 设备: ${config.gpuDevice}`);
  });
}

void main();
