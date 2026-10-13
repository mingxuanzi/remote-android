/* 工具脚本:拉取 NAS 上容器日志。用法: node scripts/nas-logs.js [容器名] [行数] */
const { Client } = require('ssh2')
const cfg = require('../publish.config.js')

const container = process.argv[2] || 'ra-api'
const lines = process.argv[3] || '80'

const conn = new Client()
conn
  .on('ready', () => {
    conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
      if (err) { console.log('exec error:', err.message); process.exit(1) }
      stream.end(cfg.password + `\ndocker logs --tail ${lines} ${container} 2>&1\n`)
      stream.on('data', (d) => process.stdout.write(d))
      stream.stderr.on('data', (d) => process.stdout.write('STDERR: ' + d))
      stream.on('close', () => { conn.end(); process.exit(0) })
    })
  })
  .on('error', (e) => { console.log('SSH 连接失败:', e.message); process.exit(1) })
  .connect({
    host: cfg.host, port: cfg.port, username: cfg.username,
    password: cfg.password, tryKeyboard: true, readyTimeout: 15000
  })
