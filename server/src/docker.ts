import Dockerode from 'dockerode';
import { config } from './config';
import { InstanceRow } from './db';
import { adbPoweroff, serialOf } from './adb';

const docker = new Dockerode({ socketPath: config.dockerSocket });

export interface CreateSpec {
  name: string;
  image: string;
  width: number;
  height: number;
  dpi: number;
  gpuMode: 'host' | 'guest';
  cpus: number;
  memoryMb: number;
}

/** 停止实例时把容器写层 commit 成的"运行镜像"标签前缀 */
const RUN_IMAGE_PREFIX = 'ra-run-';

/** 正在清除退出记录的实例:commit→改名→重建期间容器会短暂不存在,
 *  状态对账/列表查询必须跳过这些实例,避免把中间态写成"容器不存在" */
export const resettingInstances = new Set<string>();

export function runImageRef(name: string): string {
  return `${RUN_IMAGE_PREFIX}${name.toLowerCase()}`;
}

/** 由台账行构造容器规格(停止/恢复流程重建容器时需要与创建时一致的参数) */
export function specOf(row: InstanceRow): CreateSpec {
  return {
    name: row.name, image: row.image,
    width: row.width, height: row.height, dpi: row.dpi, gpuMode: row.gpuMode,
    cpus: row.cpus, memoryMb: row.memoryMb,
  };
}

/** 确保编排网络存在(api 与 redroid 实例在同一网络,adb 直连实例名:5555) */
export async function ensureNetwork(): Promise<void> {
  const nets = await docker.listNetworks({ filters: { name: [`^${config.dockerNetwork}$`] } });
  if (nets.length === 0) {
    await docker.createNetwork({ Name: config.dockerNetwork, Driver: 'bridge' });
  }
}

async function ensureImage(image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
  } catch {
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

function redroidCmd(spec: CreateSpec): string[] {
  return [
    `androidboot.redroid_width=${spec.width}`,
    `androidboot.redroid_height=${spec.height}`,
    `androidboot.redroid_dpi=${spec.dpi}`,
    `androidboot.redroid_gpu_mode=${spec.gpuMode}`, // host=宿主GPU硬渲染, guest=SwiftShader软渲染
    'androidboot.redroid_net_ndns=2',
    // 容器里没有 /etc/resolv.conf(redroid 会隐藏),必须显式指定 DNS,否则安卓无法解析域名
    `androidboot.redroid_net_dns1=${config.redroidDns1}`,
    `androidboot.redroid_net_dns2=${config.redroidDns2}`,
  ];
}

function containerConfig(spec: CreateSpec, image: string): Dockerode.ContainerCreateOptions {
  const devices =
    spec.gpuMode === 'host'
      ? [{ PathOnHost: config.gpuDevice, PathInContainer: config.gpuDevice, CgroupPermissions: 'rwm' }]
      : [];

  return {
    Image: image,
    name: spec.name,
    Cmd: redroidCmd(spec),
    ExposedPorts: { '5555/tcp': {} },
    HostConfig: {
      // binder/ashmem 需要特权模式
      Privileged: true,
      Devices: devices,
      NetworkMode: config.dockerNetwork,
      RestartPolicy: { Name: 'unless-stopped' },
      // 资源限制(redroid 官方推荐用 docker 原生 --cpus/--memory)
      NanoCpus: Math.max(1, Math.round(spec.cpus)) * 1e9,
      Memory: Math.max(256, Math.round(spec.memoryMb)) * 1024 * 1024,
    },
  };
}

export async function createAndStart(spec: CreateSpec): Promise<void> {
  await ensureNetwork();
  await ensureImage(spec.image);
  const container = await docker.createContainer(containerConfig(spec, spec.image));
  await container.start();
}

export async function startContainer(name: string): Promise<void> {
  await docker.getContainer(name).start();
}

/** 等待容器退出(容器不存在也视为已退出);超时返回 false */
async function waitExited(name: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await inspectState(name)) !== 'running') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** 清除容器退出记录:redroid 的 Android init 不处理 SIGTERM,docker stop 超时只能 SIGKILL(退出码 137);
 *  即便先经 adb 优雅关机,init 调 reboot(2) 后容器也会带 SIGINT(130) 退出 ——
 *  fnOS 等外部 Docker 面板把非 0 退出显示为"容器错误退出"。
 *  这里把已停止容器 commit 成运行镜像(写层含 /data 等全部数据),再重建一个"从未启动"的容器承接原名字:
 *  数据、快照、启停全不受影响,外部面板看到的是干净的已停止状态。
 *  任一步失败都保持原容器不动(仅外部面板继续显示退出码),不影响实例本身。 */
export async function resetExitRecord(spec: CreateSpec): Promise<void> {
  const container = docker.getContainer(spec.name);
  const info = await container.inspect().catch(() => null);
  if (!info || info.State.Running || info.State.ExitCode === 0) return;
  if (resettingInstances.has(spec.name)) return; // 已有一次清除在途

  resettingInstances.add(spec.name);
  try {
    const repo = runImageRef(spec.name);
    const oldTags = await docker
      .getImage(info.Image)
      .inspect()
      .then((i) => i.RepoTags ?? [])
      .catch(() => [] as string[]);

    const committed = await container.commit({
      repo,
      tag: 'latest',
      pause: true,
      comment: 'RemoteAndroid stop snapshot',
    });

    const parked = `${spec.name}-old-${Date.now().toString(36)}`;
    await container.rename({ name: parked });
    try {
      await ensureNetwork();
      await docker.createContainer(containerConfig(spec, `${repo}:latest`));
    } catch (e) {
      // 创建失败:旧容器改名还原,保持可启停
      await docker.getContainer(parked).rename({ name: spec.name }).catch(() => void 0);
      throw e;
    }
    await docker.getContainer(parked).remove({ force: true }).catch(() => void 0);

    // 回收上一代运行镜像(只清理本实例的 ra-run 标签;共享的基础镜像有其它引用,不动)
    if (committed?.Id && committed.Id !== info.Image && oldTags.some((t) => t.startsWith(`${repo}:`))) {
      await docker.getImage(info.Image).remove({ force: true }).catch(() => void 0);
    }
  } finally {
    resettingInstances.delete(spec.name);
  }
}

/** 停止实例:先让 Android 正常关机(容器自行退出,数据落盘),adb 不可达时兜底 docker stop;
 *  最后清除非 0 退出记录(见 resetExitRecord)。
 *  keepRecord=true 用于"重启"(容器马上会被重新启动,退出记录会被运行状态覆盖)。 */
export async function stopContainer(spec: CreateSpec, opts: { keepRecord?: boolean } = {}): Promise<void> {
  let graceful = false;
  try {
    await adbPoweroff(serialOf(spec.name));
    graceful = true; // 关机指令已送达,等容器自行退出
  } catch {
    /* adb 不可达(实例未启动完成/已退出):直接兜底 docker stop */
  }
  if (!graceful || !(await waitExited(spec.name, 20_000))) {
    await docker.getContainer(spec.name).stop({ t: 10 });
  }
  if (!opts.keepRecord) {
    await resetExitRecord(spec).catch((e) => {
      console.warn(`清除实例 ${spec.name} 的退出记录失败(不影响启停):`, describeError(e));
    });
  }
}

export async function removeContainer(name: string): Promise<void> {
  const container = docker.getContainer(name);
  try {
    await container.stop({ t: 3 });
  } catch {
    /* 已停止则忽略 */
  }
  await container.remove({ force: true });
  // 顺带回收停止流程留下的运行镜像(标签级清理,共享层由其它镜像引用保留)
  await docker.getImage(`${runImageRef(name)}:latest`).remove({ force: true }).catch(() => void 0);
}

/** 启动实例:容器在则直接启动,不在则按规格重建。
 *  自愈外部删除/宿主机重启丢容器的情况;unknown(Docker 未就绪)走重建路径,失败由调用方落台账 */
export async function launchInstance(spec: CreateSpec): Promise<void> {
  const state = await inspectState(spec.name);
  if (state === 'running') return;
  if (state === 'exited') { await startContainer(spec.name); return; }
  try {
    await createAndStart(spec);
  } catch (e) {
    // 探测期间容器已被其他途径创建:409 冲突时退化为直接启动
    if ((e as { statusCode?: number })?.statusCode === 409) await startContainer(spec.name);
    else throw e;
  }
}

export type DockerState = 'running' | 'exited' | 'missing' | 'unknown';

/** 由实例配置计算 scrcpy lock_video_orientation 值:
 *  natural → 0(设备自然方向);landscape/portrait → 与设备自然方向一致则 0,否则 1(旋转 90°) */
export function lockOrientationValue(inst: {
  width: number;
  height: number;
  orientation: 'natural' | 'landscape' | 'portrait';
}): number {
  if (inst.orientation === 'natural') return 0;
  const devicePortrait = inst.height >= inst.width;
  const wantPortrait = inst.orientation === 'portrait';
  return wantPortrait === devicePortrait ? 0 : 1;
}

/** 查询容器实时状态,用于台账状态对账。
 *  只有 404 才算"容器不存在";守护进程未就绪/连接失败等返回 unknown,
 *  调用方据此保持现状,禁止把瞬时故障固化进台账 */
export async function inspectState(name: string): Promise<DockerState> {
  try {
    const info = await docker.getContainer(name).inspect();
    return info.State.Running ? 'running' : 'exited';
  } catch (e) {
    if ((e as { statusCode?: number })?.statusCode === 404) return 'missing';
    return 'unknown';
  }
}

/** 台账状态对账:结合容器实测状态,计算实例当前应展示的状态。
 *  unknown(Docker 未就绪)一律保持不变,避免把守护进程启动期的瞬时故障写成"容器不存在";
 *  error 不是终态:容器实测恢复后按 running/stopped 自愈。
 *  过渡态(starting/stopping/restarting)期间不清空,让前端能实时展示"操作进行中",
 *  直到容器状态真正落定或由后台任务/启动恢复写入终态。返回 null 表示状态无需变更。 */
export function reconcileStatus(
  current: InstanceRow['status'],
  state: DockerState,
): InstanceRow['status'] | null {
  if (state === 'unknown') return null;
  if (current === 'creating' || current === 'starting' || current === 'restarting') {
    return state === 'running' ? 'running' : null; // 其余由所属后台任务/启动恢复收敛,避免互相踩踏
  }
  if (current === 'stopping') {
    if (state === 'running') return null; // 容器还在跑,保持"停止中"
    return state === 'missing' ? 'error' : 'stopped';
  }
  const baseline = state === 'running' ? 'running' : state === 'missing' ? 'error' : 'stopped';
  return baseline === current ? null : baseline;
}

export function describeError(err: unknown): string {
  if (err && typeof err === 'object' && 'json' in err) {
    const j = (err as { json?: { message?: string } }).json;
    if (j?.message) return j.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** 把运行中的实例容器 commit 成模板镜像(commit 默认短暂 pause 容器,完成后自动恢复) */
export async function commitInstance(containerName: string, imageRef: string): Promise<void> {
  await docker.getContainer(containerName).commit({
    repo: imageRef,
    pause: true,
    comment: 'RemoteAndroid snapshot',
  });
}

export async function removeImage(imageRef: string): Promise<void> {
  await docker.getImage(imageRef).remove({ force: true });
}

export { docker };
