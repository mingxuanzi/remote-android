/* 仅上传新 docker-compose.yml 并重建容器(镜像不变) */
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const ROOT = path.join(__dirname, '..');

async function main() {
  const compose = cfg.compose
    .replace(/\{\{IMAGE_API\}\}/g, `${cfg.images.api}:0.0.55`)
    .replace(/\{\{IMAGE_WEB\}\}/g, `${cfg.images.web}:0.0.55`);
  const local = path.join(ROOT, '.publish', 'docker-compose.yml');
  fs.writeFileSync(local, compose + '\n', 'utf8');
  const conn = new Client();
  await new Promise((res, rej) => conn.on('ready', res).on('error', rej).connect({
    host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password,
    tryKeyboard: true, readyTimeout: 30000,
  }));
  const sftp = await new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))));
  await new Promise((res, rej) => sftp.fastPut(local, `${cfg.remoteDir}/docker-compose.yml`, (e) => (e ? rej(e) : res())));
  sftp.end();
  console.log('compose uploaded, recreating containers...');
  await new Promise((res, rej) => {
    conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
      if (err) return rej(err);
      stream.end(cfg.password + `\ncd ${cfg.remoteDir}\ndocker compose up -d --remove-orphans\ndocker compose ps\n`);
      stream.on('data', (d) => process.stdout.write(d));
      stream.stderr.on('data', (d) => process.stdout.write(d));
      stream.on('close', res);
    });
  });
  conn.end();
  console.log('done');
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
