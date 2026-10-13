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

export type DockerState = 'running' | 'exited' | 'missing';

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

/** 查询容器实时状态,用于台账状态对账 */
export async function inspectState(name: string): Promise<DockerState> {
  try {
    const info = await docker.getContainer(name).inspect();
    return info.State.Running ? 'running' : 'exited';
  } catch {
    return 'missing';
  }
}

/** 台账状态对账:结合容器实测状态,计算实例当前应展示的状态。
 *  过渡态(starting/stopping/restarting)期间不清空,让前端能实时展示"操作进行中",
 *  直到容器状态真正落定或由后台任务写入终态。返回 null 表示状态无需变更。 */
export function reconcileStatus(
  current: InstanceRow['status'],
  state: DockerState,
): InstanceRow['status'] | null {
  if (current === 'creating' || current === 'error') return null;
  if (current === 'stopping') {
    if (state === 'running') return null; // 容器还在跑,保持"停止中"
    return state === 'missing' ? 'error' : 'stopped';
  }
  if (current === 'starting' || current === 'restarting') {
    if (state === 'running') return 'running';
    if (state === 'missing') return 'error';
    return null; // exited:拉起/重启尚未完成,保持过渡态
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
