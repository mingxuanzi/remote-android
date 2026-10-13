const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const c = new Client();
c.on('ready', () => {
  c.exec("sudo -S -p '' /bin/sh", (e, s) => {
    if (e) { console.log(e.message); process.exit(1); }
    s.end(cfg.password + "\npython3 -c \"import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.sendto(b'A'*1400, ('192.168.0.2',9999)); s.sendto(b'B'*100, ('192.168.0.2',9999)); print('sent')\" 2>&1 || echo no-python3\n");
    s.on('data', d => process.stdout.write(d));
    s.stderr.on('data', d => process.stdout.write(d));
    s.on('close', () => { c.end(); process.exit(0); });
  });
}).on('error', e => { console.log(e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
