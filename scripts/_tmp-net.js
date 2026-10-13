/* 临时脚本:查 resolv.conf + 运行时配 DNS 验证 */
const { Client } = require('ssh2')
const cfg = require('../publish.config.js')

const conn = new Client()
conn
  .on('ready', () => {
    const A = 'docker exec ra-api adb -s test1:5555'
    const script = [
      'echo "===== 容器 resolv.conf ====="',
      'docker exec test1 cat /etc/resolv.conf 2>&1 || echo "读取失败"',
      'echo "===== 运行时配 DNS ====="',
      `${A} shell "ndc resolver setnetdns eth0 '' 223.5.5.5 223.6.6.6" 2>&1`,
      `${A} shell "getprop net.dns1; getprop net.dns2" 2>&1`,
      'echo "===== ping 域名验证 ====="',
      `${A} shell "ping -c 2 -W 3 www.baidu.com" 2>&1 | tail -3`
    ].join('\n')
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
    password: cfg.password, tryKeyboard: true, readyTimeout: 15000
  })
