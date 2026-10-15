#!/usr/bin/env node
/**
 * 在 WSL 发行版里安装 Docker 引擎（docker.io + buildx + compose 插件）并设为随发行版自启。
 * 装好之后 `npm run publish` 会优先使用 WSL 里的引擎，不需要启动 Docker Desktop。
 *
 *   npm run setup:wsl-docker                 # 自动选择发行版（默认 Ubuntu-24.04）
 *   npm run setup:wsl-docker -- Debian       # 指定发行版
 *
 * 安装需要 root，脚本用 `wsl -u root` 执行，无需输入 WSL 密码。
 *
 * 另外会把镜像存储固定为「经典存储（overlay2）」：Docker 29 默认用 containerd 快照存储，
 * `docker save` 会导出 OCI 布局的 tar；飞牛 NAS 上通常是经典存储的 Docker，
 * 换回经典存储后导出格式与以往 Docker Desktop 发布完全一致（docker-archive）。
 */
const { listWslDistros, runWsl, DEFAULT_WSL_DISTRO, isWindows, shQuote } = require('./docker-engine')

const APT_PACKAGES = ['docker.io', 'docker-buildx', 'docker-compose-v2']
const DAEMON_JSON = '{"features":{"containerd-snapshotter":false}}'

function log(message) {
  console.log(message)
}

function fail(message) {
  console.error(`\n安装失败: ${message}`)
  process.exit(1)
}

/** 该发行版的默认用户（用于加入 docker 组，方便手动敲 docker 命令） */
function defaultUser(distro) {
  try {
    const result = runWsl(distro, 'root', "sed -n 's/^default=//p' /etc/wsl.conf 2>/dev/null || true", {
      timeout: 30000
    })
    const first = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0]
    if (!first) return ''
    // 兜底：若拿到的是整行 "default=mxz" 也取等号后半段
    const name = first.includes('=') ? first.slice(first.indexOf('=') + 1) : first
    return /^[A-Za-z0-9._-]+$/.test(name) ? name : ''
  } catch {
    return ''
  }
}

function dockerInstalled(distro) {
  const result = runWsl(distro, 'root', '[ -x /usr/bin/docker ] && [ -x /usr/bin/dockerd ] && echo yes || echo no', {
    timeout: 60000
  })
  return /yes/.test(result.stdout || '')
}

/** 镜像存储固定为经典存储（overlay2）：与 NAS 上一致，且避免 containerd 快照存储
 *  构建时附带 provenance 证明清单（manifest list），确保 docker save 出来的包
 *  在老一些的 docker load 上也能直接加载。失败会回滚，不影响引擎可用性。 */
function ensureClassicStore(distro) {
  const driver = () =>
    String(
      runWsl(distro, 'root', 'docker info --format "{{.Driver}}" 2>/dev/null || echo unknown', { timeout: 60000 }).stdout || ''
    ).trim()
  const current = driver()
  if (current === 'overlay2') {
    log(' 镜像存储已是经典存储（overlay2），与 NAS 一致')
    return
  }
  const existing = String(runWsl(distro, 'root', 'cat /etc/docker/daemon.json 2>/dev/null || true').stdout || '').trim()
  if (existing) {
    log(' 检测到自定义 /etc/docker/daemon.json，未自动修改')
    log(' 如需与 NAS 完全一致的导出格式，可手动加入 "features":{"containerd-snapshotter":false} 并重启 docker')
    return
  }

  log(` 当前存储驱动为 ${current || 'unknown'}（containerd 快照存储），切换为经典存储...`)
  const apply = runWsl(
    distro,
    'root',
    `printf '%s\\n' ${shQuote(DAEMON_JSON)} > /etc/docker/daemon.json && systemctl restart docker && sleep 5 && docker info --format "{{.Driver}}"`,
    { timeout: 180000 }
  )
  if (apply.status === 0 && String(apply.stdout || '').trim() === 'overlay2') {
    log(' 已切换为经典存储（overlay2）')
    return
  }
  log(' 切换失败，回滚 daemon.json 并恢复原存储...')
  runWsl(distro, 'root', 'rm -f /etc/docker/daemon.json && systemctl restart docker && sleep 5 && echo rolled-back', {
    inherit: true,
    timeout: 180000
  })
  log(' 继续使用 containerd 快照存储；若 NAS 上 docker load 报错，请手动改用经典存储')
}

function pickDistro(argDistro) {
  const all = listWslDistros()
  if (!all.length) fail('没有检测到任何 WSL 发行版，请先执行 `wsl --install`')
  const usable = all.filter((name) => !/^docker-desktop$/i.test(name))
  if (argDistro) {
    if (!all.includes(argDistro)) fail(`发行版「${argDistro}」不存在，当前可用: ${all.join(', ')}`)
    return argDistro
  }
  return (
    usable.find((name) => name === DEFAULT_WSL_DISTRO) ||
    usable.find((name) => /^ubuntu/i.test(name)) ||
    usable.find((name) => /^debian/i.test(name)) ||
    usable[0]
  )
}

function main() {
  if (!isWindows()) fail('该脚本只在 Windows + WSL 环境下使用')
  const distro = pickDistro((process.argv[2] || '').trim())
  if (!distro) fail('未找到可用的 WSL 发行版')

  log('============================================')
  log(' 在 WSL 里安装 Docker 引擎')
  log('============================================')
  log(` 发行版: ${distro}`)
  log(` 组件: ${APT_PACKAGES.join(' ')}`)

  if (dockerInstalled(distro)) {
    log('\n[1/4] Docker 引擎已安装，跳过 apt 安装')
  } else {
    log(`\n[1/4] apt 安装（首次约 300MB，请耐心等待）...`)
    const install = runWsl(
      distro,
      'root',
      'export DEBIAN_FRONTEND=noninteractive; apt-get update -q && apt-get install -y -q ' + APT_PACKAGES.join(' '),
      { inherit: true, timeout: 0 }
    )
    if (install.status !== 0) fail(`apt 安装返回 ${install.status}，请检查网络后重试`)
  }

  log('\n[2/4] 设置 Docker 服务随发行版自启...')
  const enable = runWsl(distro, 'root', 'systemctl enable --now docker && sleep 2 && systemctl is-active docker', {
    inherit: true,
    timeout: 180000
  })
  if (enable.status !== 0) {
    log(' systemctl 启动失败，尝试 service 方式...')
    const fallback = runWsl(distro, 'root', 'service docker start', { inherit: true, timeout: 120000 })
    if (fallback.status !== 0) fail('无法启动 Docker 服务')
  }

  log('\n[3/4] 固定镜像存储为经典存储（与 NAS 上的 docker load 一致）...')
  ensureClassicStore(distro)

  log('\n[4/4] 把默认用户加入 docker 组（方便在 WSL 终端里直接用 docker）...')
  const user = defaultUser(distro)
  if (user && user !== 'root') {
    const added = runWsl(distro, 'root', `usermod -aG docker ${shQuote(user)} && echo "已加入: ${user}"`, {
      inherit: true,
      timeout: 60000
    })
    if (added.status !== 0) log(` 加入 docker 组失败（不影响 npm run publish，发布用 root 调用）`)
  } else {
    log(' 未找到默认用户，跳过（不影响 npm run publish）')
  }

  log('\n校验引擎...')
  const server = String(
    runWsl(distro, 'root', 'docker info --format "{{.ServerVersion}} / {{.Driver}}"', { timeout: 60000 }).stdout || ''
  ).trim()
  const client = String(
    runWsl(distro, 'root', 'docker version --format "{{.Client.Version}}"', { timeout: 60000 }).stdout || ''
  ).trim()
  if (!/^\d/.test(server)) fail('Docker 引擎校验失败')
  log(` server=${server}  client=${client}`)

  log('\n============================================')
  log(' 完成，现在可以直接 npm run publish')
  log(' 说明: 发布脚本默认以 root 调用 WSL 里的 docker，不受 docker 组成员身份影响；')
  log(`       想在 WSL 终端里直接用 docker 命令，执行一次 wsl --terminate ${distro} 让组权限生效。`)
  log('============================================\n')
}

main()
