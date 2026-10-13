const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const conn = new Client();
conn.on('ready', () => {
  conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
    if (err) { console.log('err', err.message); process.exit(1); }
    stream.end(cfg.password + "\nss -tlnp 2>/dev/null | grep -E '8189|8889|8554|9997' || netstat -tlnp 2>/dev/null | grep -E '8189|8889|8554|9997'\necho '---udp---'\nss -ulnp 2>/dev/null | grep 8189 || netstat -ulnp 2>/dev/null | grep 8189\n");
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stdout.write('ERR:' + d));
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
}).on('error', e => { console.log('SSH fail:', e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
