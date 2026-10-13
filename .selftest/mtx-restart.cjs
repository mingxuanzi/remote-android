const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const c = new Client();
c.on('ready', () => {
  c.exec("sudo -S -p '' /bin/sh", (e, s) => {
    if (e) { console.log(e.message); process.exit(1); }
    s.end(cfg.password + "\ndocker restart ra-mediamtx && sleep 3 && docker ps --format '{{.Names}} {{.Status}}' | grep ra-\n");
    s.on('data', d => process.stdout.write(d));
    s.stderr.on('data', d => process.stdout.write(d));
    s.on('close', () => { c.end(); process.exit(0); });
  });
}).on('error', e => { console.log(e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
