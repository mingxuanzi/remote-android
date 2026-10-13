const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const conn = new Client();
conn.on('ready', () => {
  conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
    if (err) { console.log('err', err.message); process.exit(1); }
    stream.end(cfg.password + "\ndocker exec ra-api sh -c 'curl -s -o /tmp/p.json -w \"%{http_code}\" http://mediamtx:9997/v3/paths/list; echo; cat /tmp/p.json; echo'\n");
    let out = '';
    stream.on('data', d => { out += d; });
    stream.stderr.on('data', d => { out += 'ERR:' + d; });
    stream.on('close', () => { console.log(out); conn.end(); process.exit(0); });
  });
}).on('error', e => { console.log('SSH fail:', e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
