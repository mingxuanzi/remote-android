/* 诊断 MediaMTX API:状态码/头 + mediamtx 环境 */
const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const code = `
fetch('http://mediamtx:9997/v3/paths/list').then(r=>r.text().then(t=>console.log('paths/list status',r.status,'len',t.length,'body:',t.slice(0,200))))
.then(()=>fetch('http://mediamtx:9997/v3/config/global/get').then(r=>r.text().then(t=>console.log('config status',r.status,'body:',t.slice(0,300)))))
.catch(e=>console.log('ERR',e.message))`;
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
