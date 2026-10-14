import { execFile } from 'node:child_process';

/** adb over tcp 的 serial:实例容器名:5555(同一 Docker 网络内直连) */
export function serialOf(name: string): string {
  return `${name}:5555`;
}

export function adb(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('adb', args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout);
    });
  });
}

export async function adbConnect(serial: string, timeoutMs = 60_000): Promise<string> {
  return adb(['connect', serial], timeoutMs);
}

/** 通知 Android 正常关机(init 走完关机流程后容器自行退出):
 *  docker stop 的 SIGTERM 会被 redroid 的 init 忽略,最终只能 SIGKILL(退出码 137)。
 *  adb connect 无论成败都以 0 退出,需按输出判断连接是否建立,连不上时抛错让调用方走兜底;
 *  关机指令送达后设备立即断开,shell 命令多半以报错收场,送达即视为成功。 */
export async function adbPoweroff(serial: string): Promise<void> {
  const out = await adbConnect(serial, 8_000);
  if (!/connected to /i.test(out)) throw new Error(out.trim() || `adb 连接失败: ${serial}`);
  await adbShell(serial, 'reboot -p', 10_000).catch(() => void 0);
}

export async function adbShell(serial: string, cmd: string, timeoutMs = 60_000): Promise<string> {
  return adb(['-s', serial, 'shell', cmd], timeoutMs);
}

/** 等待 redroid 启动完成(adb 可连 + Android 已 boot) */
export async function waitForBoot(serial: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      await adbConnect(serial);
      const out = await adbShell(serial, 'getprop sys.boot_completed', 10_000);
      if (out.trim() === '1') return;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`等待实例启动超时: ${lastErr || serial}`);
}

export async function adbInstall(serial: string, apkPath: string): Promise<string> {
  return adb(['-s', serial, 'install', '-r', apkPath], 300_000);
}
