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

export async function adbConnect(serial: string): Promise<void> {
  await adb(['connect', serial]);
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
