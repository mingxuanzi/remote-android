const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const c = new Client();
c.on('ready', () => {
  c.exec("sudo -S -p '' /bin/sh", (e, s) => {
    if (e) { console.log(e.message); process.exit(1); }
    s.end(cfg.password + "\nss -tnp | grep -E ':8554|mediamtx' | head -5\necho '--- all established to 8554 ---'\nss -tn state established '( dport = :8554 or sport = :8554 )'\n");
    s.on('data', d => process.stdout.write(d));
    s.stderr.on('data', d => process.stdout.write(d));
    s.on('close', () => { c.end(); process.exit(0); });
  });
}).on('error', e => { console.log(e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
