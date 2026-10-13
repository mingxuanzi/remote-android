/* 本次观看是否只有一路 WHEP 会话(无重连churn) */
const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const conn = new Client();
conn.on('ready', () => {
  conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
    if (err) { console.log('err', err.message); process.exit(1); }
    stream.end(cfg.password + `
echo '===== api rtc logs ====='
docker logs ra-api -t --since 4m 2>&1 | grep -E 'rtc' | tail -15
echo '===== mediamtx WebRTC sessions ====='
docker logs ra-mediamtx -t --since 4m 2>&1 | grep -E 'WebRTC|RTSP' | tail -15
`);
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', () => {});
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
}).on('error', e => { console.log('SSH fail:', e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
