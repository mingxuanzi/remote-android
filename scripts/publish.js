const { execSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { pipeline } = require('stream/promises')
const { Client } = require('ssh2')

const ROOT = path.join(__dirname, '..')
const VERSION_FILE = path.join(ROOT, 'version.txt')
const CONFIG_FILE = path.join(ROOT, 'publish.config.js')
const EXAMPLE_FILE = path.join(ROOT, 'publish.config.example.js')
const PUBLISH_DIR = path.join(ROOT, '.publish')

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isDockerReady() {
  try {
    execSync('docker info', {
      stdio: 'pipe',
      timeout: 15000,
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}

function hasDockerCli() {
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

function findDockerDesktopExe() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Docker', 'Docker', 'Docker Desktop.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Docker', 'Docker Desktop.exe')
  ]
  return candidates.find((p) => p && fs.existsSync(p)) || null
}

function isDockerDesktopRunning() {
  if (process.platform !== 'win32') return false
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
  const child = spawn(exePath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
}

async function ensureDocker(timeoutMs = 180000) {
  if (isDockerReady()) {
    console.log(' Docker 已就绪')
    return
  }

  if (process.platform !== 'win32') {
    throw new Error('Docker 未运行，请先启动 Docker 后再发布')
  }

  const exe = findDockerDesktopExe()
  if (!exe && !hasDockerCli()) {
    throw new Error(
      '未检测到 Docker Desktop，请先安装：https://www.docker.com/products/docker-desktop/'
    )
  }

  if (!isDockerDesktopRunning()) {
    if (!exe) {
      throw new Error('Docker 未运行，且未找到 Docker Desktop.exe，请手动启动后再发布')
    }
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
    if (isDockerReady()) {
      process.stdout.write('\n')
      console.log(' Docker Desktop 已就绪')
      return
    }
  }
  process.stdout.write('\n')
  throw new Error(`等待 Docker Desktop 启动超时（${Math.round(timeoutMs / 1000)}s），请手动打开后再发布`)
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function readVersion() {
  if (!fs.existsSync(VERSION_FILE)) {
    fs.writeFileSync(VERSION_FILE, '0.0.1\n', 'utf8')
    return '0.0.1'
  }
  return fs.readFileSync(VERSION_FILE, 'utf8').trim() || '0.0.1'
}

function bumpPatch(version) {
  const parts = version.split('.').map((n) => parseInt(n, 10) || 0)
  while (parts.length < 3) parts.push(0)
  parts[2] += 1
  return parts.join('.')
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      `缺少 publish.config.js。请先复制示例并填写飞牛 NAS 信息：\n` +
        `  copy ${path.basename(EXAMPLE_FILE)} publish.config.js`
    )
  }
  const config = require(CONFIG_FILE)
  const required = ['host', 'username', 'password', 'remoteDir', 'compose']
  for (const key of required) {
    if (!config[key] || String(config[key]).trim() === '') {
      throw new Error(`publish.config.js 缺少配置项: ${key}`)
    }
  }
  if (!config.images || !config.images.api || !config.images.web) {
    throw new Error('publish.config.js 缺少配置项: images.api / images.web')
  }
  if (config.password === 'your-password') {
    throw new Error('请在 publish.config.js 中填写真实的飞牛 NAS 密码')
  }
  for (const placeholder of ['{{IMAGE_API}}', '{{IMAGE_WEB}}']) {
    if (!String(config.compose).includes(placeholder)) {
      throw new Error(`compose 中必须包含 ${placeholder}，发布时会替换为本地镜像名:版本号`)
    }
  }
  return {
    host: config.host,
    port: config.port || 22,
    username: config.username,
    password: config.password,
    remoteDir: config.remoteDir.replace(/\\/g, '/').replace(/\/+$/, ''),
    images: { api: config.images.api, web: config.images.web },
    seedImages: Array.isArray(config.seedImages) ? config.seedImages : [],
    platform: config.platform,
    sudo: !!config.sudo,
    sudoPassword: config.sudoPassword || config.password,
    keepRemoteTar: !!config.keepRemoteTar,
    compose: String(config.compose).trim()
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function connectSsh(config) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn
      .on('ready', () => resolve(conn))
      .on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        finish(prompts.map(() => config.password))
      })
      .on('error', reject)
      .connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        tryKeyboard: true,
        readyTimeout: 30000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 10
      })
  })
}

function isNoisyRemoteChunk(text) {
  return /\.bashrc:/.test(text) || /common\.sh: Permission denied/.test(text)
}

function execRemote(conn, command, options = {}) {
  const { stdinData, label, allowFail } = options
  return new Promise((resolve, reject) => {
    console.log(`\n$ ${label || command}`)
    conn.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      if (stdinData != null) {
        stream.end(stdinData.endsWith('\n') ? stdinData : `${stdinData}\n`)
      }
      stream
        .on('close', (code) => {
          if (code !== 0 && !allowFail) {
            reject(
              new Error(`远程命令失败 (exit ${code}): ${label || 'remote'}\n${stderr || stdout}`)
            )
            return
          }
          resolve(stdout)
        })
        .on('data', (data) => {
          stdout += data
          if (!isNoisyRemoteChunk(data.toString())) process.stdout.write(data)
        })
      stream.stderr.on('data', (data) => {
        stderr += data
        if (!isNoisyRemoteChunk(data.toString())) process.stderr.write(data)
      })
    })
  })
}

async function remoteNeedsSudo(conn, config) {
  if (config.sudo) return true
  try {
    await execRemote(conn, '/bin/sh -c "docker info >/dev/null 2>&1"', {
      label: '检测远程 docker 权限'
    })
    return false
  } catch {
    console.log(' 远程 docker 需要 sudo，将使用 SSH 密码提权')
    return true
  }
}

function uploadFile(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err)
      const total = fs.statSync(localPath).size
      let lastPct = -1
      const started = Date.now()
      sftp.fastPut(
        localPath,
        remotePath,
        {
          step: (transferred) => {
            const pct = total ? Math.floor((transferred / total) * 100) : 100
            if (pct !== lastPct && (pct === 100 || pct - lastPct >= 2)) {
              lastPct = pct
              const elapsed = (Date.now() - started) / 1000 || 1
              const speed = transferred / elapsed
              process.stdout.write(
                `\r  上传 ${path.basename(localPath)}  ${pct}%  ${formatBytes(transferred)}/${formatBytes(total)}  ${formatBytes(speed)}/s`
              )
            }
          }
        },
        (putErr) => {
          sftp.end()
          process.stdout.write('\n')
          if (putErr) reject(putErr)
          else resolve()
        }
      )
    })
  })
}

async function saveImagesGzip(imageTags, destGz) {
  const child = spawn('docker', ['save', ...imageTags], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const exitPromise = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  try {
    await pipeline(
      child.stdout,
      zlib.createGzip({ level: 6 }),
      fs.createWriteStream(destGz)
    )
  } catch (err) {
    await exitPromise.catch(() => {})
    throw err
  }
  const exitCode = await exitPromise
  if (exitCode !== 0) {
    throw new Error(`docker save 退出码 ${exitCode}`)
  }
}

async function tryPull(image) {
  // 基础镜像本地已有时，离线环境 docker pull 会卡住整个发布；失败则用本地镜像继续（build 已 --pull=false）
  try {
    run(`docker pull ${image}`)
  } catch {
    console.log(`  docker pull ${image} 失败（可能离线/镜像已存在），使用本地镜像继续构建`)
  }
}

async function main() {
  const config = loadConfig()
  const version = readVersion()
  const apiTag = `${config.images.api}:${version}`
  const webTag = `${config.images.web}:${version}`
  const tarName = `remote-android-${version}.tar.gz`
  const localTar = path.join(PUBLISH_DIR, tarName)
  const localCompose = path.join(PUBLISH_DIR, 'docker-compose.yml')
  const localKernelScript = path.join(ROOT, 'scripts', 'load-kernel-modules.sh')
  const remoteTar = `${config.remoteDir}/${tarName}`
  const remoteCompose = `${config.remoteDir}/docker-compose.yml`
  const remoteKernelScript = `${config.remoteDir}/load-kernel-modules.sh`
  const composeYaml = config.compose
    .replace(/\{\{IMAGE_API\}\}/g, apiTag)
    .replace(/\{\{IMAGE_WEB\}\}/g, webTag)

  fs.mkdirSync(PUBLISH_DIR, { recursive: true })
  fs.writeFileSync(localCompose, `${composeYaml}\n`, 'utf8')

  console.log('============================================')
  console.log(' 发布 RemoteAndroid 到飞牛 NAS（离线镜像）')
  console.log('============================================')
  console.log(` 版本: ${version}`)
  console.log(` 镜像: ${apiTag} + ${webTag}`)
  console.log(` 目标: ${config.username}@${config.host}:${config.remoteDir}`)
  console.log('============================================')

  console.log('\n[1/6] 检查本机 Docker...')
  await ensureDocker()
  run('docker version')

  console.log('\n[2/6] 构建 api/web 两个镜像...')
  await tryPull('node:20-bookworm')
  await tryPull('nginx:1.27-alpine')
  const platformFlag = config.platform ? ` --platform ${config.platform}` : ''
  run(`docker build${platformFlag} --pull=false -t ${apiTag} ./server`)
  run(`docker build${platformFlag} --pull=false -t ${webTag} ./web`)

  // 可选:把 redroid 等种子镜像一起打包(NAS 访问不了 Docker Hub 时,由本机代拉)
  for (const seed of config.seedImages) {
    console.log(`\n 拉取种子镜像 ${seed}(随包推送到 NAS)...`)
    await tryPull(seed)
  }

  console.log('\n[3/6] 导出离线镜像(多镜像合并打包)...')
  if (fs.existsSync(localTar)) fs.unlinkSync(localTar)
  await saveImagesGzip([apiTag, webTag, ...config.seedImages], localTar)
  console.log(` 已生成 ${localTar} (${formatBytes(fs.statSync(localTar).size)})`)

  console.log('\n[4/6] 上传到飞牛 NAS...')
  const conn = await connectSsh(config)
  try {
    await execRemote(
      conn,
      `mkdir -p ${shQuote(config.remoteDir)} ${shQuote(`${config.remoteDir}/data`)} ${shQuote(`${config.remoteDir}/certs`)}`
    )
    await uploadFile(conn, localTar, remoteTar)
    await uploadFile(conn, localCompose, remoteCompose)
    if (fs.existsSync(localKernelScript)) {
      await uploadFile(conn, localKernelScript, remoteKernelScript)
    }

    console.log('\n[5/6] 加载镜像并用 docker compose 启动...')
    const cleanup = config.keepRemoteTar ? '' : `\nrm -f ${shQuote(remoteTar)}`
    const remoteScript = `
set -e
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
cd ${shQuote(config.remoteDir)}
echo "[nas] docker load ${tarName}"
docker load -i ${shQuote(remoteTar)}
if docker compose version >/dev/null 2>&1; then
  echo "[nas] docker compose up -d --pull never"
  docker compose up -d --remove-orphans --pull never
  docker compose ps
elif command -v docker-compose >/dev/null 2>&1; then
  echo "[nas] docker-compose up -d"
  docker-compose up -d --remove-orphans
  docker-compose ps
else
  echo "未找到 docker compose / docker-compose"
  exit 1
fi
${cleanup}
`.trim()
    const needSudo = await remoteNeedsSudo(conn, config)
    const runRemote = (script, label, opts = {}) =>
      needSudo
        ? execRemote(conn, "sudo -S -p '' /bin/sh", {
            stdinData: `${config.sudoPassword}\n${script}\n`,
            label,
            ...opts
          })
        : execRemote(conn, `/bin/sh -c ${shQuote(script)}`, { label, ...opts })

    await runRemote(remoteScript, 'docker load && compose up')

    console.log('\n[6/6] 检查 NAS 安卓内核模块(binder/ashmem)...')
    const check = `
if [ -e /dev/binder ] || [ -d /dev/binderfs ]; then
  echo "[nas] binder 设备就绪"
else
  modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null || true
  modprobe ashmem_linux 2>/dev/null || true
fi
if [ -e /dev/binder ] || [ -d /dev/binderfs ]; then
  echo "[nas] binder 检查通过"
else
  echo "[nas][警告] 未检测到 binder 设备,redroid 实例将无法启动!"
  echo "[nas][警告] 请 SSH 到 NAS 执行: sudo bash ${remoteKernelScript}"
  echo "[nas][警告] 若脚本报 modprobe 错误,说明 fnOS 内核未编译 binder 模块,需更换/重编译内核"
fi
`.trim()
    await runRemote(check, 'binder 模块检查(失败仅警告)', { allowFail: true })
  } finally {
    conn.end()
  }

  try {
    fs.unlinkSync(localTar)
  } catch (_) {
    /* ignore */
  }

  const next = bumpPatch(version)
  fs.writeFileSync(VERSION_FILE, `${next}\n`, 'utf8')

  const portMatch = composeYaml.match(/["'](\d+):\d+["']/)
  const hostPort = portMatch ? portMatch[1] : '80'

  console.log('\n============================================')
  console.log(' 发布成功')
  console.log(` 镜像: ${apiTag} + ${webTag}`)
  console.log(` 访问: http://${config.host}:${hostPort}`)
  console.log(` 下一版本号: ${next}`)
  console.log(' 提示: 首次创建实例会在 NAS 上拉取 redroid 镜像(约1~2GB),')
  console.log('       若 Docker Hub 不通,请先在 fnOS 的 Docker 设置里配镜像加速器')
  console.log('============================================\n')
}

main().catch((err) => {
  console.error('\n发布失败:', err.message || err)
  process.exit(1)
})
