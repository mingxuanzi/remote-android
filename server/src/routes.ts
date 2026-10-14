import { Router, Request } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { config } from './config';
import { instanceStore, templateStore, userStore, InstanceRow, newId } from './db';
import {
  createAndStart, stopContainer, removeContainer, inspectState,
  describeError, commitInstance, removeImage, reconcileStatus, launchInstance, specOf, resettingInstances,
} from './docker';
import { adbInstall, serialOf, waitForBoot } from './adb';
import {
  requireAuth, requireAdmin, canAccess, signToken, verifyPassword, hashPassword, ensureAdminUser,
} from './auth';
import { ensure, destroyForInstance, reconfigureInstance } from './sessions';
import { RtcSession } from './rtc';

export const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } });

const okName = (n: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(n);

/* ---------------- 认证(公开接口) ---------------- */

router.post('/auth/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const user = username ? userStore.getByUsername(String(username)) : undefined;
  if (!user || !verifyPassword(String(password ?? ''), user.passwordHash)) {
    return void res.status(401).json({ error: '用户名或密码错误' });
  }
  res.json({
    token: signToken(user),
    user: { id: user.id, username: user.username, role: user.role, maxInstances: user.maxInstances },
  });
});

/* ---------------- 以下全部需要登录 ---------------- */
router.use(requireAuth);

router.get('/auth/me', (req, res) => {
  const u = req.user!;
  res.json({ id: u.id, username: u.username, role: u.role, maxInstances: u.maxInstances });
});

router.post('/auth/change-password', (req, res) => {
  const { oldPassword, newPassword } = req.body ?? {};
  const u = req.user!;
  if (!verifyPassword(String(oldPassword ?? ''), u.passwordHash)) {
    return void res.status(400).json({ error: '原密码错误' });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return void res.status(400).json({ error: '新密码至少 6 位' });
  }
  userStore.update(u.id, { passwordHash: hashPassword(String(newPassword)) });
  res.json({ ok: true });
});

/* ---------------- 实例 ---------------- */

/** 异步创建实例(批量多开时每实例独立任务),失败落台账 message */
async function provision(row: InstanceRow): Promise<void> {
  try {
    await createAndStart({
      name: row.name, image: row.image,
      width: row.width, height: row.height, dpi: row.dpi, gpuMode: row.gpuMode,
      cpus: row.cpus, memoryMb: row.memoryMb,
    });
    instanceStore.setStatus(row.id, 'running');
  } catch (e) {
    instanceStore.setStatus(row.id, 'error', describeError(e));
  }
}

/** 权限过滤后的实例查询(找不到或无权都按 404 处理) */
function ownedInstance(req: Request, id: string): InstanceRow | undefined {
  const row = instanceStore.get(id);
  return row && canAccess(req.user!, row.ownerId) ? row : undefined;
}

router.get('/instances', async (req, res) => {
  const u = req.user!;
  const rows = u.role === 'admin' ? instanceStore.list() : instanceStore.listByOwner(u.id);
  const merged = await Promise.all(
    rows.map(async (r) => {
      if (resettingInstances.has(r.name)) return r; // 退出记录清除中,容器短暂不存在属预期
      const state = await inspectState(r.name);
      const next = reconcileStatus(r.status, state);
      if (next) {
        instanceStore.setStatus(r.id, next, next === 'error' ? '容器不存在' : '');
        return { ...r, status: next };
      }
      return r;
    }),
  );
  res.json(merged);
});

router.post('/instances', async (req, res) => {
  const {
    name, image = config.redroidImage,
    width = 1080, height = 1920, dpi = 440,
    gpuMode = 'host', count = 1,
    cpus = 2, memoryMb = 2048,
  } = req.body ?? {};

  const u = req.user!;
  const n = Math.min(Math.max(Number(count) || 1, 1), 50);
  const cpuN = Math.min(Math.max(Number(cpus) || 2, 1), 32);
  const memN = Math.min(Math.max(Number(memoryMb) || 2048, 512), 65536);
  if (u.role !== 'admin' && instanceStore.countByOwner(u.id) + n > u.maxInstances) {
    return void res.status(403).json({ error: `超出配额:最多 ${u.maxInstances} 个实例` });
  }

  const created: InstanceRow[] = [];
  for (let i = 0; i < n; i++) {
    const instName = n === 1 && name ? String(name) : `${name ? String(name) + '-' : 'ra-'}${newId()}`;
    if (!okName(instName)) return void res.status(400).json({ error: `非法实例名: ${instName}` });
    if (instanceStore.getByName(instName)) return void res.status(409).json({ error: `实例名已存在: ${instName}` });
    const row = instanceStore.insert({
      id: newId(), name: instName, image: String(image),
      width: Number(width), height: Number(height), dpi: Number(dpi),
      gpuMode: gpuMode === 'host' ? 'host' : 'guest',
      orientation: ['landscape', 'portrait'].includes(req.body?.orientation) ? req.body.orientation : 'natural',
      cpus: cpuN, memoryMb: memN,
      ownerId: u.id, status: 'creating', message: '',
    });
    created.push(row);
    void provision(row); // 后台拉起容器
  }
  res.status(202).json(created);
});

/** 操作已受理、容器尚未落定时,立即返回过渡态,后台任务完成后写终态。
 *  前端轮询 /instances 即可实时看到 启动中/停止中/重启中 → 终态 的变化。 */
router.post('/instances/:id/start', (req, res) => {
  const row = ownedInstance(req, req.params.id);
  if (!row) return void res.status(404).json({ error: '实例不存在' });
  if (row.status === 'running' || row.status === 'starting') {
    return void res.status(409).json({ error: '实例已在运行' });
  }
  instanceStore.setStatus(row.id, 'starting');
  void (async () => {
    try {
      await launchInstance({
        name: row.name, image: row.image,
        width: row.width, height: row.height, dpi: row.dpi, gpuMode: row.gpuMode,
        cpus: row.cpus, memoryMb: row.memoryMb,
      });
      instanceStore.setStatus(row.id, 'running');
    } catch (e) {
      const st = await inspectState(row.name).catch(() => 'unknown' as const);
      if (st === 'running') instanceStore.setStatus(row.id, 'running');
      else instanceStore.setStatus(row.id, 'error', describeError(e));
    }
  })();
  res.json({ ok: true, status: 'starting' });
});

router.post('/instances/:id/stop', (req, res) => {
  const row = ownedInstance(req, req.params.id);
  if (!row) return void res.status(404).json({ error: '实例不存在' });
  if (row.status === 'stopped' || row.status === 'stopping') {
    return void res.status(409).json({ error: '实例已停止' });
  }
  destroyForInstance(row.id);
  instanceStore.setStatus(row.id, 'stopping');
  void (async () => {
    try {
      await stopContainer(specOf(row));
      instanceStore.setStatus(row.id, 'stopped');
    } catch (e) {
      const st = await inspectState(row.name).catch(() => 'unknown' as const);
      if (st !== 'running') instanceStore.setStatus(row.id, 'stopped');
      else instanceStore.setStatus(row.id, 'error', describeError(e));
    }
  })();
  res.json({ ok: true, status: 'stopping' });
});

router.post('/instances/:id/restart', (req, res) => {
  const row = ownedInstance(req, req.params.id);
  if (!row) return void res.status(404).json({ error: '实例不存在' });
  destroyForInstance(row.id);
  instanceStore.setStatus(row.id, 'restarting');
  void (async () => {
    try {
      await stopContainer(specOf(row), { keepRecord: true }).catch(() => void 0);
      await launchInstance({
        name: row.name, image: row.image,
        width: row.width, height: row.height, dpi: row.dpi, gpuMode: row.gpuMode,
        cpus: row.cpus, memoryMb: row.memoryMb,
      });
      instanceStore.setStatus(row.id, 'running');
    } catch (e) {
      const st = await inspectState(row.name).catch(() => 'unknown' as const);
      if (st === 'running') instanceStore.setStatus(row.id, 'running');
      else instanceStore.setStatus(row.id, 'error', describeError(e));
    }
  })();
  res.json({ ok: true, status: 'restarting' });
});

router.delete('/instances/:id', async (req, res) => {
  const row = ownedInstance(req, req.params.id);
  if (!row) return void res.status(404).json({ error: '实例不存在' });
  try {
    destroyForInstance(row.id);
    await removeContainer(row.name).catch(() => void 0);
    instanceStore.remove(row.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: describeError(e) });
  }
});

router.post('/instances/batch', (req, res) => {
  const { action, ids } = req.body ?? {};
  if (!Array.isArray(ids) || !['start', 'stop', 'delete'].includes(action)) {
    return void res.status(400).json({ error: '参数错误' });
  }
  const results: Record<string, string> = {};
  for (const id of ids as string[]) {
    const row = ownedInstance(req, id);
    if (!row) { results[id] = '实例不存在或无权操作'; continue; }
    results[id] = 'accepted';
    if (action === 'start') {
      instanceStore.setStatus(id, 'starting');
      void (async () => {
        try {
          await launchInstance({
            name: row.name, image: row.image,
            width: row.width, height: row.height, dpi: row.dpi, gpuMode: row.gpuMode,
            cpus: row.cpus, memoryMb: row.memoryMb,
          });
          instanceStore.setStatus(id, 'running');
        } catch (e) {
          const st = await inspectState(row.name).catch(() => 'unknown' as const);
          if (st === 'running') instanceStore.setStatus(id, 'running');
          else instanceStore.setStatus(id, 'error', describeError(e));
        }
      })();
    } else if (action === 'stop') {
      destroyForInstance(row.id);
      instanceStore.setStatus(id, 'stopping');
      void (async () => {
        try {
          await stopContainer(specOf(row));
          instanceStore.setStatus(id, 'stopped');
        } catch (e) {
          const st = await inspectState(row.name).catch(() => 'unknown' as const);
          if (st !== 'running') instanceStore.setStatus(id, 'stopped');
          else instanceStore.setStatus(id, 'error', describeError(e));
        }
      })();
    } else {
      destroyForInstance(row.id);
      void (async () => {
        await removeContainer(row.name).catch(() => void 0);
        instanceStore.remove(id);
      })();
    }
  }
  res.json(results);
});

router.post('/instances/:id/install', upload.single('apk'), async (req, res) => {
  const row = ownedInstance(req, req.params.id);
  if (!row) return void res.status(404).json({ error: '实例不存在' });
  if (!req.file) return void res.status(400).json({ error: '缺少 apk 文件' });

  const tmp = path.join(os.tmpdir(), `ra-${newId()}.apk`);
  fs.writeFileSync(tmp, req.file.buffer);
  try {
    const serial = serialOf(row.name);
    await waitForBoot(serial);
    const out = await adbInstall(serial, tmp);
    res.json({ ok: true, output: out.trim() });
  } catch (e) {
    res.status(500).json({ error: describeError(e) });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

/** 切换方向模式(natural/landscape/portrait)。
 *  策略:落库 + 关闭存量会话(同步完成),前端按 key 重挂载播放器时按新参数重建会话,
 *  黑屏期 = 重建耗时(2~4s),期间前端有 loading 遮罩,不再是无尽黑屏。 */
router.patch('/instances/:id/orientation', async (req, res) => {
  const row = ownedInstance(req, req.params.id);
  if (!row) return void res.status(404).json({ error: '实例不存在' });
  const { orientation } = req.body ?? {};
  if (!['natural', 'landscape', 'portrait'].includes(orientation)) {
    return void res.status(400).json({ error: 'orientation 必须是 natural/landscape/portrait' });
  }
  instanceStore.setOrientation(row.id, orientation);
  try {
    await reconfigureInstance({ ...row, orientation });
    res.json({ ok: true, orientation });
  } catch (e) {
    res.status(500).json({ error: describeError(e) });
  }
});

/* ---------------- WebRTC 推流 ---------------- */

/** 预热 WebRTC 会话(scrcpy 2.4 → JS RTP → MediaMTX),返回 WHEP 播放地址 */
router.post('/instances/:id/rtc/start', async (req, res) => {
  const row = ownedInstance(req, req.params.id);
  if (!row) return void res.status(404).json({ error: '实例不存在' });
  if (row.status !== 'running') return void res.status(409).json({ error: '实例未在运行' });
  try {
    const entry = await ensure(row, 'rtc');
    const session = entry.session as RtcSession;
    // 等首帧发布(首发 IDR 已补发)再下发地址,否则前端 WHEP 会落入
    // "路径未发布 → 404 重试 → 挂上时错过首发 IDR → 看门狗误触发"的启动竞赛
    await Promise.race([
      session.firstPublishPromise,
      new Promise((r) => setTimeout(r, 8_000)),
    ]);
    // MediaMTX 的 WHEP 路径形态是 /<path>/whep(不是 /whep/<path>)
    res.json({ whepUrl: `/${session.whepPath}/whep` });
  } catch (e) {
    res.status(500).json({ error: describeError(e) });
  }
});

/** 硬重置 WebRTC 会话:前端连续协商失败时的自愈入口(销毁后由后续请求重建) */
router.post('/instances/:id/rtc/reset', (req, res) => {
  const row = ownedInstance(req, req.params.id);
  if (!row) return void res.status(404).json({ error: '实例不存在' });
  destroyForInstance(row.id);
  res.json({ ok: true });
});

/* ---------------- 快照模板 ---------------- */

router.get('/templates', (req, res) => {
  const u = req.user!;
  const all = templateStore.list();
  res.json(u.role === 'admin' ? all : all.filter((t) => t.ownerId === u.id));
});

/** 把运行中的实例保存为模板(docker commit) */
router.post('/instances/:id/snapshot', async (req, res) => {
  const row = ownedInstance(req, req.params.id);
  if (!row) return void res.status(404).json({ error: '实例不存在' });
  const { name, note = '' } = req.body ?? {};
  if (!name || !okName(String(name))) return void res.status(400).json({ error: '模板名必填(字母数字_-.)' });
  if (templateStore.getByName(String(name))) return void res.status(409).json({ error: '模板名已存在' });

  const imageRef = `ra-snap-${String(name).toLowerCase()}:latest`;
  try {
    await commitInstance(row.name, imageRef);
    const tpl = templateStore.insert({
      id: newId(), name: String(name), imageRef,
      width: row.width, height: row.height, dpi: row.dpi, gpuMode: row.gpuMode,
      cpus: row.cpus, memoryMb: row.memoryMb,
      sourceInstance: row.name, note: String(note), ownerId: req.user!.id,
    });
    res.json(tpl);
  } catch (e) {
    res.status(500).json({ error: describeError(e) });
  }
});

/** 从模板开新实例(走配额) */
router.post('/templates/:id/spawn', async (req, res) => {
  const tpl = templateStore.get(req.params.id);
  if (!tpl || !canAccess(req.user!, tpl.ownerId)) return void res.status(404).json({ error: '模板不存在' });

  const u = req.user!;
  const { name, count = 1 } = req.body ?? {};
  const n = Math.min(Math.max(Number(count) || 1, 1), 50);
  if (u.role !== 'admin' && instanceStore.countByOwner(u.id) + n > u.maxInstances) {
    return void res.status(403).json({ error: `超出配额:最多 ${u.maxInstances} 个实例` });
  }

  const created: InstanceRow[] = [];
  for (let i = 0; i < n; i++) {
    const instName = `${name ? String(name) + '-' : 'tpl-'}${newId()}`;
    const row = instanceStore.insert({
      id: newId(), name: instName, image: tpl.imageRef,
      width: tpl.width, height: tpl.height, dpi: tpl.dpi, gpuMode: tpl.gpuMode,
      orientation: 'natural',
      cpus: tpl.cpus, memoryMb: tpl.memoryMb,
      ownerId: u.id, status: 'creating', message: '',
    });
    created.push(row);
    void provision(row);
  }
  res.status(202).json(created);
});

router.delete('/templates/:id', async (req, res) => {
  const tpl = templateStore.get(req.params.id);
  if (!tpl || !canAccess(req.user!, tpl.ownerId)) return void res.status(404).json({ error: '模板不存在' });
  try {
    await removeImage(tpl.imageRef).catch(() => void 0);
    templateStore.remove(tpl.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: describeError(e) });
  }
});

/* ---------------- 用户管理(admin) ---------------- */

router.get('/users', requireAdmin, (_req, res) => {
  res.json(userStore.list().map((u) => ({
    id: u.id, username: u.username, role: u.role, maxInstances: u.maxInstances, createdAt: u.createdAt,
  })));
});

router.post('/users', requireAdmin, (req, res) => {
  const { username, password, role = 'user', maxInstances = 5 } = req.body ?? {};
  if (!username || !okName(String(username))) return void res.status(400).json({ error: '用户名必填(字母数字_-.)' });
  if (!password || String(password).length < 6) return void res.status(400).json({ error: '密码至少 6 位' });
  if (userStore.getByUsername(String(username))) return void res.status(409).json({ error: '用户名已存在' });
  const u = userStore.insert({
    id: newId(), username: String(username), passwordHash: hashPassword(String(password)),
    role: role === 'admin' ? 'admin' : 'user', maxInstances: Math.max(1, Number(maxInstances) || 5),
  });
  res.json({ id: u.id, username: u.username, role: u.role, maxInstances: u.maxInstances });
});

router.patch('/users/:id', requireAdmin, (req, res) => {
  const u = userStore.get(req.params.id);
  if (!u) return void res.status(404).json({ error: '用户不存在' });
  const { maxInstances, role, password } = req.body ?? {};
  const patch: Parameters<typeof userStore.update>[1] = {};
  if (maxInstances !== undefined) patch.maxInstances = Math.max(1, Number(maxInstances) || 1);
  if (role !== undefined && ['admin', 'user'].includes(role)) patch.role = role;
  if (password) {
    if (String(password).length < 6) return void res.status(400).json({ error: '密码至少 6 位' });
    patch.passwordHash = hashPassword(String(password));
  }
  userStore.update(u.id, patch);
  res.json({ ok: true });
});

router.delete('/users/:id', requireAdmin, (req, res) => {
  const u = userStore.get(req.params.id);
  if (!u) return void res.status(404).json({ error: '用户不存在' });
  if (u.id === req.user!.id) return void res.status(400).json({ error: '不能删除自己' });
  userStore.remove(u.id);
  res.json({ ok: true });
});

/* ---------------- 配置 ---------------- */

router.get('/config', (_req, res) => {
  res.json({
    redroidImage: config.redroidImage,
    gpuDevice: config.gpuDevice,
    scrcpyBitrate: config.scrcpyBitrate,
    scrcpyFps: config.scrcpyFps,
    scrcpyVersion: config.scrcpyVersion,
  });
});

export { ensureAdminUser };
