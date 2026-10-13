const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const conn = new Client();
conn.on('ready', () => {
  conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
    if (err) { console.log('err', err.message); process.exit(1); }
    stream.end(cfg.password + "\ndocker exec ra-mediamtx wget -qO- http://127.0.0.1:9997/v3/paths/list 2>&1 | head -c 3000\ndocker logs --tail 30 ra-mediamtx 2>&1\n");
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stdout.write('STDERR: ' + d));
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
}).on('error', e => { console.log('SSH fail:', e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
