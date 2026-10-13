/* 从 ra-api 容器内测 MediaMTX API 连通性 */
const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const conn = new Client();
conn.on('ready', () => {
  conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
    if (err) { console.log('err', err.message); process.exit(1); }
    stream.end(cfg.password + `
echo '===== api 容器内访问 mediamtx API ====='
docker exec ra-api sh -c "wget -qO- -T 5 http://mediamtx:9997/v3/paths/list || curl -s -m 5 http://mediamtx:9997/v3/paths/list || echo FETCH_FAILED"
echo
`);
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stdout.write(d));
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
}).on('error', e => { console.log('SSH fail:', e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
