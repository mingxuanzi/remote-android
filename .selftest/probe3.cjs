/* ra-api rtc 日志 + mediamtx paths + mediamtx 日志 */
const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const conn = new Client();
conn.on('ready', () => {
  conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
    if (err) { console.log('err', err.message); process.exit(1); }
    stream.end(cfg.password + `
echo '===== api rtc logs ====='
docker logs ra-api --since 4m 2>&1 | grep -E 'rtc|RTSP|dbg' | tail -25
echo '===== mediamtx paths ====='
curl -s http://127.0.0.1:9997/v3/paths/list | head -c 1500
echo
echo '===== mediamtx logs ====='
docker logs ra-mediamtx --since 4m 2>&1 | tail -20
`);
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', () => {});
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
}).on('error', e => { console.log('SSH fail:', e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
