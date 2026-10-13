import Dockerode from 'dockerode';
import { config } from './config';
import { InstanceRow } from './db';

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

export async function createAndStart(spec: CreateSpec): Promise<void> {
  await ensureNetwork();
  await ensureImage(spec.image);

  const devices =
    spec.gpuMode === 'host'
      ? [{ PathOnHost: config.gpuDevice, PathInContainer: config.gpuDevice, CgroupPermissions: 'rwm' }]
      : [];

  const container = await docker.createContainer({
    Image: spec.image,
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
  });
  await container.start();
}

export async function startContainer(name: string): Promise<void> {
  await docker.getContainer(name).start();
}

export async function stopContainer(name: string): Promise<void> {
  await docker.getContainer(name).stop({ t: 10 });
}

export async function removeContainer(name: string): Promise<void> {
  const container = docker.getContainer(name);
  try {
    await container.stop({ t: 3 });
  } catch {
    /* 已停止则忽略 */
  }
  await container.remove({ force: true });
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
