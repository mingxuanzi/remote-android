const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const HOST = process.env.RA_HOST || cfg.host || '127.0.0.1';
const conn = new Client();
conn.on('ready', () => {
  conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
    if (err) { console.log('err', err.message); process.exit(1); }
    stream.end(cfg.password + `\ndocker exec ra-api sh -c 'echo 8554:; curl -s -m 5 -o /dev/null -w "%{http_code}" http://${HOST}:8554/x; echo; echo 8889:; curl -s -m 5 -o /dev/null -w "%{http_code}" http://${HOST}:8889/x; echo'\n`);
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stdout.write('ERR:' + d));
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
}).on('error', e => { console.log('SSH fail:', e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
