/* 看 ra-api 最近日志 + MediaMTX paths 状态 */
const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const conn = new Client();
conn.on('ready', () => {
  conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
    if (err) { console.log('err', err.message); process.exit(1); }
    stream.end(cfg.password + `
echo '===== ra-api logs ====='
docker logs ra-api --tail 80 2>&1
echo '===== mediamtx paths ====='
curl -s http://127.0.0.1:9997/v3/paths/list
echo
`);
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', () => {});
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
}).on('error', e => { console.log('SSH fail:', e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
