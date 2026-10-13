const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const TARGET = process.env.RA_TARGET_HOST || '127.0.0.1';
const c = new Client();
c.on('ready', () => {
  c.exec("sudo -S -p '' /bin/sh", (e, s) => {
    if (e) { console.log(e.message); process.exit(1); }
    s.end(cfg.password + `\nbash -c 'for i in 1 2 3; do echo -n hello-udp-$i > /dev/udp/${TARGET}/9999; sleep 1; done' && echo sent\n`);
    s.on('data', d => process.stdout.write(d));
    s.stderr.on('data', d => process.stdout.write(d));
    s.on('close', () => { c.end(); process.exit(0); });
  });
}).on('error', e => { console.log(e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
