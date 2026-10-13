/* 临时脚本:在 NAS 上 sudo modprobe binder 验证内核是否带安卓模块 */
const { Client } = require('ssh2')
const cfg = require('../publish.config.js')

const conn = new Client()
conn
  .on('ready', () => {
    const script = [
      'modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>&1 && echo MOD_BINDER_OK || echo MOD_BINDER_FAIL',
      'modprobe ashmem_linux 2>&1 && echo MOD_ASHMEM_OK || echo MOD_ASHMEM_FAIL',
      'ls /dev/binder /dev/ashmem 2>/dev/null || ls -d /dev/binderfs 2>/dev/null || echo STILL_MISSING',
      'zgrep -E "CONFIG_ANDROID_BINDERFS|CONFIG_ASHMEM" /proc/config.gz 2>/dev/null || echo NO_PROC_CONFIG',
      'ls /lib/modules/$(uname -r)/kernel/drivers/android/ 2>/dev/null || echo NO_ANDROID_DRIVER_DIR'
    ].join('; ')
    conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
      if (err) { console.log('exec error:', err.message); process.exit(1) }
      stream.end(cfg.password + '\n' + script + '\n')
      stream.on('data', (d) => process.stdout.write(d))
      stream.stderr.on('data', (d) => process.stdout.write('STDERR: ' + d))
      stream.on('close', () => { conn.end(); process.exit(0) })
    })
  })
  .on('error', (e) => { console.log('SSH 连接失败:', e.message); process.exit(1) })
  .connect({
    host: cfg.host, port: cfg.port, username: cfg.username,
    password: cfg.password, tryKeyboard: true, readyTimeout: 12000
  })
