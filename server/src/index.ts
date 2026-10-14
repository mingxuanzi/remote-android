import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { config } from './config';
import { initDb, instanceStore } from './db';
import {
  ensureNetwork, inspectState, reconcileStatus, launchInstance, stopContainer, describeError,
  specOf, resetExitRecord, resettingInstances,
} from './docker';
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
    if (resettingInstances.has(row.name)) continue; // 退出记录清除中,容器短暂不存在属预期
    const state = await inspectState(row.name);
    const next = reconcileStatus(row.status, state);
    if (next) {
      instanceStore.setStatus(row.id, next, next === 'error' ? '容器不存在' : '');
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 启动恢复:上次进程可能死在过渡态操作中途(如重启机器),后台任务已随进程消亡。
 *  stopping 补停,starting/restarting/creating 补拉(用户意图是运行)。
 *  Docker 守护进程刚启动时容器可能尚未恢复(inspect 返回 unknown),多轮重试直到全部落定。 */
async function recoverStaleTransitions(): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const stale = instanceStore.list().filter((r) =>
      ['creating', 'starting', 'stopping', 'restarting'].includes(r.status),
    );
    if (!stale.length) return;
    for (const row of stale) {
      const state = await inspectState(row.name);
      if (state === 'unknown') continue; // Docker 未就绪,下一轮再收敛
      if (row.status === 'stopping') {
        if (state === 'running') await stopContainer(specOf(row)).catch(() => void 0);
        const after = await inspectState(row.name);
        instanceStore.setStatus(row.id, after === 'missing' ? 'error' : 'stopped',
          after === 'missing' ? '容器不存在' : '');
      } else {
        try {
          await launchInstance({
            name: row.name, image: row.image,
            width: row.width, height: row.height, dpi: row.dpi, gpuMode: row.gpuMode,
            cpus: row.cpus, memoryMb: row.memoryMb,
          });
          instanceStore.setStatus(row.id, 'running');
        } catch (e) {
          const st = await inspectState(row.name);
          if (st === 'running') instanceStore.setStatus(row.id, 'running');
          else instanceStore.setStatus(row.id, 'error', describeError(e));
        }
      }
    }
    await sleep(5000);
  }
}

/** 一次性修复:旧版本的停止流程让容器以 137/130 退出,fnOS 等外部 Docker 面板显示"容器错误退出"。
 *  对当前处于已停止的实例清除退出记录(commit 写层后重建容器,数据不变),
 *  发布升级后无需手动启停即可让外部面板恢复干净状态。 */
async function repairStoppedExitRecords(): Promise<void> {
  for (const row of instanceStore.list()) {
    if (row.status !== 'stopped') continue;
    try {
      await resetExitRecord(specOf(row));
    } catch (e) {
      console.warn(`清除实例 ${row.name} 的退出记录失败(可忽略):`, describeError(e));
    }
  }
}

async function main(): Promise<void> {
  await ensureNetwork().catch((e) => console.warn('创建 Docker 网络失败(可忽略,稍后自动重试):', e));
  void (async () => {
    await recoverStaleTransitions().catch((e) => console.warn('启动恢复失败:', e));
    await repairStoppedExitRecords().catch((e) => console.warn('退出记录修复失败:', e));
  })();
  setInterval(() => void reconcile().catch(() => void 0), 5_000);

  server.listen(config.port, () => {
    console.log(`RemoteAndroid API listening on :${config.port}`);
    console.log(`redroid 镜像: ${config.redroidImage} | GPU 设备: ${config.gpuDevice}`);
  });
}

void main();
