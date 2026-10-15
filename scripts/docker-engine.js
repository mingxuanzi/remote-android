/**
 * Docker 引擎解析与调用封装。
 *
 * `npm run publish` 需要在**本机**跑 docker build / docker save，
 * 但引擎不一定来自 Docker Desktop：
 *
 *   1. 本机引擎已就绪（Docker Desktop 或本机 dockerd）→ 直接用；
 *   2. 否则 WSL 发行版里装了 Docker Engine（docker.io / docker-ce）→ 用 WSL 里的引擎，
 *      不必启动 Docker Desktop；
 *   3. 都没有 → 保持旧行为：自动启动 Docker Desktop。
 *
 * publish.config.js 可用 docker: 'auto' | 'desktop' | 'wsl' 强制指定，
 * wslDistro / wslUser 可指定发行版与执行用户（默认取第一个装了 Docker 的发行版，root）。
 */
const { execFileSync, execSync, spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { pipeline } = require('stream/promises')

const DEFAULT_WSL_DISTRO = 'Ubuntu-24.04'
const CAPTURE_TIMEOUT = 20000

const isWindows = () => process.platform === 'win32'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** POSIX 单引号转义，供远程 shell / WSL bash 使用 */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 统一成数组，便于一次 save 多个镜像 */
function toTagList(imageTags) {
  return Array.isArray(imageTags) ? imageTags : [imageTags]
}

/**
 * 构建期代理参数（Docker 预定义 build args，无需改 Dockerfile）。
 * 本机开着 Clash/mihomo 这类 TUN 代理时，容器走 fake-IP 的链路容易在批量下载中途被掐断
 * （npm 会卡在 CLOSE-WAIT 死连接上），显式指定 HTTP 代理端口会稳很多。
 * publish.config.js: buildProxy: 'auto' | 'http://ip:port'
 */
function buildProxyArgs(config, kind, capture) {
  let proxy = String((config && config.buildProxy) || '').trim()
  if (!proxy) return ''
  if (proxy === 'auto') {
    if (kind !== 'wsl' || typeof capture !== 'function') {
      console.log(' 提示: buildProxy=auto 只支持 WSL 引擎，本机引擎请填完整地址')
      return ''
    }
    let gateway = ''
    try {
      // 注意：命令经 wsl.exe 传递时 $ 会被吞掉，这里避免使用 awk 的 $N
      gateway = capture("ip route 2>/dev/null | head -1 | cut -d' ' -f3")
    } catch {
      gateway = ''
    }
    if (!/^[0-9.]+$/.test(gateway)) return ''
    proxy = `http://${gateway}:${Number((config && config.buildProxyPort) || 10090)}`
  }
  const noProxy = String((config && config.buildNoProxy) || 'localhost,127.0.0.1')
  const entries = [
    ['HTTP_PROXY', proxy],
    ['HTTPS_PROXY', proxy],
    ['NO_PROXY', noProxy],
    ['http_proxy', proxy],
    ['https_proxy', proxy],
    ['no_proxy', noProxy]
  ]
  console.log(` 构建代理: ${proxy}`)
  return entries.map(([key, value]) => ` --build-arg ${key}=${value}`).join('')
}

/** Windows 路径 → WSL 里的 /mnt/<盘符>/... 路径 */
function toWslPath(winPath) {
  const abs = path.resolve(winPath)
  const matched = /^([A-Za-z]):[\\/](.*)$/.exec(abs)
  if (!matched) return abs.replace(/\\/g, '/')
  return `/mnt/${matched[1].toLowerCase()}/${matched[2].replace(/\\/g, '/')}`
}

function wslArgs(distro, user, bashCommand) {
  const args = []
  if (distro) args.push('-d', distro)
  if (user) args.push('-u', user)
  args.push('--', 'bash', '-lc', bashCommand)
  return args
}

/** 在 WSL 里执行一条 bash 命令；inherit=true 时输出直通终端 */
function runWsl(distro, user, bashCommand, options = {}) {
  const { inherit = false, timeout = CAPTURE_TIMEOUT } = options
  const result = spawnSync('wsl.exe', wslArgs(distro, user, bashCommand), {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout
  })
  if (result.error) throw result.error
  return result
}

/** 列出 WSL 发行版（wsl -l -q 输出为 UTF-16LE，不能按 UTF-8 读） */
function listWslDistros() {
  if (!isWindows()) return []
  try {
    const raw = execFileSync('wsl.exe', ['-l', '-q'], { windowsHide: true, timeout: 15000 })
    return raw
      .toString('utf16le')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/\u0000/g, '').trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 该发行版里是否装了 Linux 版 Docker 引擎。
 * 注意不能只判断 `docker` 命令是否存在：WSL 的 interop 会把 Windows 版
 * Docker Desktop CLI（/mnt/c/.../docker.exe）暴露进来，造成假阳性。
 */
function hasLinuxDocker(distro, user = 'root') {
  try {
    const result = runWsl(distro, user, '[ -x /usr/bin/docker ] && [ -x /usr/bin/dockerd ] && echo ok', {
      timeout: 60000
    })
    return result.status === 0 && /ok/.test(result.stdout || '')
  } catch {
    return false
  }
}

/** 选出可用的 WSL 发行版：优先配置指定，其次默认名，再按 ubuntu/debian 顺序探测 */
function pickWslDistro(preferred) {
  if (!isWindows()) return null
  const all = listWslDistros()
  if (!all.length) return null
  const candidates = all.filter((name) => !/^docker-desktop$/i.test(name))

  if (preferred && preferred.trim()) {
    const wanted = preferred.trim()
    if (!all.includes(wanted)) {
      throw new Error(
        `publish.config.js 里的 wslDistro「${wanted}」不存在，当前发行版: ${all.join(', ') || '（无）'}`
      )
    }
    return hasLinuxDocker(wanted) ? wanted : null
  }

  const ordered = [
    DEFAULT_WSL_DISTRO,
    ...candidates.filter((name) => /^ubuntu/i.test(name)),
    ...candidates.filter((name) => /debian/i.test(name)),
    ...candidates
  ].filter((name, index, arr) => candidates.includes(name) && arr.indexOf(name) === index)

  for (const name of ordered) {
    if (hasLinuxDocker(name)) return name
  }
  return null
}

/* ---------------- 本机引擎（Docker Desktop / 本机 dockerd） ---------------- */

function findDockerDesktopExe() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Docker', 'Docker', 'Docker Desktop.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Docker', 'Docker Desktop.exe')
  ]
  return candidates.find((p) => p && fs.existsSync(p)) || null
}

function isDockerDesktopRunning() {
  if (!isWindows()) return false
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Docker Desktop.exe" /FO CSV /NH', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    return /docker desktop\.exe/i.test(out)
  } catch {
    return false
  }
}

function startDockerDesktop(exePath) {
  console.log(` 启动 Docker Desktop: ${exePath}`)
  const child = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

function hasLocalDockerCli() {
  try {
    execSync('docker version --format "{{.Client.Version}}"', {
      stdio: 'pipe',
      timeout: 10000,
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}

function isLocalDockerReady() {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 15000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** 旧行为：没有其它可用引擎时，自动拉起 Docker Desktop */
async function ensureDockerDesktop(timeoutMs = 180000) {
  if (isLocalDockerReady()) {
    console.log(' Docker 已就绪')
    return
  }
  if (!isWindows()) {
    throw new Error('Docker 未运行，请先启动 Docker 后再发布')
  }
  const exe = findDockerDesktopExe()
  if (!exe && !hasLocalDockerCli()) {
    throw new Error(
      '未检测到可用的 Docker 引擎。可选其一：\n' +
        '  1) npm run setup:wsl-docker  在 WSL 里安装 Docker 引擎（无需 Docker Desktop）\n' +
        '  2) 安装 Docker Desktop: https://www.docker.com/products/docker-desktop/'
    )
  }
  if (!isDockerDesktopRunning()) {
    if (!exe) throw new Error('Docker 未运行，且未找到 Docker Desktop.exe，请手动启动后再发布')
    startDockerDesktop(exe)
  } else {
    console.log(' Docker Desktop 已在启动中，等待引擎就绪...')
  }
  const deadline = Date.now() + timeoutMs
  let waited = 0
  while (Date.now() < deadline) {
    await sleep(3000)
    waited += 3
    process.stdout.write(`\r 等待 Docker 引擎就绪... ${waited}s`)
    if (isLocalDockerReady()) {
      process.stdout.write('\n')
      console.log(' Docker Desktop 已就绪')
      return
    }
  }
  process.stdout.write('\n')
  throw new Error(`等待 Docker Desktop 启动超时（${Math.round(timeoutMs / 1000)}s），请手动打开后再发布`)
}

function saveImageGzipLocal(imageTags, destGz, rootDir) {
  const child = spawn('docker', ['save', ...toTagList(imageTags)], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const exitPromise = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  return pipeline(child.stdout, zlib.createGzip({ level: 6 }), fs.createWriteStream(destGz))
    .catch(async (err) => {
      await exitPromise.catch(() => {})
      throw err
    })
    .then(async () => {
      const exitCode = await exitPromise
      if (exitCode !== 0) throw new Error(`docker save 退出码 ${exitCode}`)
    })
}

function createLocalEngine(rootDir, config) {
  return {
    kind: 'local',
    label: isDockerDesktopRunning() ? '本机 Docker（Docker Desktop）' : '本机 Docker 引擎',
    toEnvPath: (p) => p,
    buildProxyArgs: () => buildProxyArgs(config, 'local', null),
    capture(command) {
      return execSync(command, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: CAPTURE_TIMEOUT
      }).trim()
    },
    runShell(command) {
      console.log(`\n> ${command}`)
      execSync(command, { stdio: 'inherit', cwd: rootDir, windowsHide: true })
    },
    saveGzip: (imageTags, destGz) => saveImageGzipLocal(imageTags, destGz, rootDir)
  }
}

/* ---------------- WSL 引擎 ---------------- */

function createWslEngine({ distro, user = 'root', rootDir, config }) {
  const wslRoot = toWslPath(rootDir)
  const inProject = (command) => `cd ${shQuote(wslRoot)} && ${command}`
  const capture = (command) => {
    const result = runWsl(distro, user, command)
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim()
      throw new Error(detail || `WSL 命令失败 (exit ${result.status}): ${command}`)
    }
    return String(result.stdout || '').trim()
  }
  return {
    kind: 'wsl',
    distro,
    label: `WSL ${distro} 内的 Docker Engine`,
    toEnvPath: toWslPath,
    buildProxyArgs: () => buildProxyArgs(config, 'wsl', capture),
    capture,
    runShell(command) {
      console.log(`\n> [WSL ${distro}] ${command}`)
      const result = runWsl(distro, user, inProject(command), { inherit: true, timeout: 0 })
      if (result.status !== 0) throw new Error(`命令失败 (exit ${result.status}): ${command}`)
    },
    async saveGzip(imageTags, destGz) {
      const dest = toWslPath(destGz)
      const tags = toTagList(imageTags)
      // 在 WSL 内直接 save | gzip 落盘，避免几百 MB 二进制穿过 wsl.exe 管道
      console.log(`\n> [WSL ${distro}] docker save ${tags.join(' ')} | gzip > ${dest}`)
      const result = runWsl(distro, user, `docker save ${tags.map(shQuote).join(' ')} | gzip -6 > ${shQuote(dest)}`, {
        inherit: true,
        timeout: 0
      })
      if (result.status !== 0) throw new Error(`docker save 失败 (exit ${result.status})`)
    }
  }
}

/** 确保 WSL 里的 dockerd 已运行（systemd 已启用的发行版一般会随发行版自启） */
async function ensureWslDaemon(engine, timeoutMs = 90000) {
  const probe = () => {
    try {
      engine.capture('docker info --format "{{.ServerVersion}}"')
      return true
    } catch {
      return false
    }
  }
  if (probe()) return true

  console.log(' WSL 里的 Docker 服务未运行，尝试启动...')
  try {
    engine.capture('systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true')
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + timeoutMs
  let waited = 0
  while (Date.now() < deadline) {
    await sleep(2000)
    waited += 2
    process.stdout.write(`\r 等待 WSL Docker 引擎就绪... ${waited}s`)
    if (probe()) {
      process.stdout.write('\n')
      return true
    }
  }
  process.stdout.write('\n')
  return false
}

/* ---------------- 对外入口 ---------------- */

/**
 * 解析本次发布要使用的 Docker 引擎。
 * @param {object} config publish.config.js（含 docker / wslDistro / wslUser）
 * @param {string} rootDir 仓库根目录（docker build 的上下文）
 */
async function resolveEngine(config, rootDir) {
  const mode = String(config.docker || 'auto').trim().toLowerCase()
  if (!['auto', 'desktop', 'wsl'].includes(mode)) {
    throw new Error(`publish.config.js 的 docker 只能是 auto / desktop / wsl，当前为「${config.docker}」`)
  }

  // 1) 本机引擎已就绪（Docker Desktop 运行时，或本机装了 dockerd）
  if (mode !== 'wsl' && isLocalDockerReady()) {
    const engine = createLocalEngine(rootDir, config)
    console.log(` 使用${engine.label}（本机 docker 已就绪）`)
    return engine
  }

  // 2) WSL 里的 Docker Engine
  if (mode !== 'desktop' && isWindows()) {
    const distro = pickWslDistro(config.wslDistro)
    if (distro) {
      const engine = createWslEngine({ distro, user: config.wslUser || 'root', rootDir, config })
      console.log(` 本机 Docker 未运行，改用 WSL ${distro} 里的 Docker Engine`)
      if (await ensureWslDaemon(engine)) return engine
      console.log(` WSL ${distro} 里的 Docker 引擎不可用`)
    } else if (mode === 'wsl') {
      throw new Error(
        '没有找到装有 Docker 引擎的 WSL 发行版。\n' +
          '  先执行：npm run setup:wsl-docker\n' +
          '  或在 publish.config.js 里指定 wslDistro / 把 docker 设为 desktop'
      )
    }
  } else if (mode === 'wsl') {
    throw new Error('当前系统不是 Windows，无法使用 WSL 引擎；请把 publish.config.js 的 docker 设为 desktop/auto')
  }

  if (mode === 'wsl') {
    throw new Error('WSL 里的 Docker 引擎不可用，请执行 npm run setup:wsl-docker 后重试')
  }

  // 3) 回退：自动启动 Docker Desktop（旧行为）
  await ensureDockerDesktop()
  return createLocalEngine(rootDir, config)
}

module.exports = {
  DEFAULT_WSL_DISTRO,
  isWindows,
  shQuote,
  toWslPath,
  wslArgs,
  runWsl,
  listWslDistros,
  hasLinuxDocker,
  pickWslDistro,
  createWslEngine,
  ensureWslDaemon,
  isLocalDockerReady,
  isDockerDesktopRunning,
  ensureDockerDesktop,
  resolveEngine
}
