const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const conn = new Client();
conn.on('ready', () => {
  conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
    if (err) { console.log('err', err.message); process.exit(1); }
    stream.end(cfg.password + "\niptables -L INPUT -n -v --line-numbers 2>/dev/null | head -30\necho '---udp 8189 hits---'\niptables -L INPUT -n -v 2>/dev/null | grep -E '8189|dpt:81|Policy'\necho '---nft---'\nnft list ruleset 2>/dev/null | head -5\n");
    stream.on('data', d => process.stdout.write(d));
    stream.stderr.on('data', d => process.stdout.write('ERR:' + d));
    stream.on('close', () => { conn.end(); process.exit(0); });
  });
}).on('error', e => { console.log('SSH fail:', e.message); process.exit(1); })
.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, tryKeyboard: true, readyTimeout: 15000 });
