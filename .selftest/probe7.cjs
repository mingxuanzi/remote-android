/* 用 api 容器内的 node 测 MediaMTX API(base64 传码,避开引号问题) */
const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const code = `fetch('http://mediamtx:9997/v3/paths/list').then(r=>r.text()).then(t=>console.log('OK',t.slice(0,800))).catch(e=>console.log('ERR',e.message))`;
const b64 = Buffer.from(code).toString('base64');
const conn = new Client();
conn.on('ready', () => {
  conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
    if (err) { console.log('err', err.message); process.exit(1); }
    stream.end(cfg.password + `\ndocker exec ra-api sh -c 'echo ${b64} | base64 -d | node'\n`);
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stdout.write(d));
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
}).on('error', e => { console.log('SSH fail:', e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
