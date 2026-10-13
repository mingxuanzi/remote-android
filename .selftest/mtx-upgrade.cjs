/* 拉取并部署新版 mediamtx 到 NAS(种子镜像方式,只传 mediamtx 一个镜像) */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const ROOT = path.join(__dirname, '..');
const TAG = 'bluenviron/mediamtx:1.12.3';
const TAR = path.join(ROOT, '.publish', 'mediamtx-new.tar.gz');

async function main() {
  console.log('> docker pull', TAG);
  await new Promise((res, rej) => {
    const p = spawn('docker', ['pull', TAG], { stdio: 'inherit' });
    p.on('close', (c) => (c === 0 ? res() : rej(new Error('pull failed'))));
  });
  console.log('> docker save');
  const child = spawn('docker', ['save', TAG], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exitP = new Promise((res) => child.on('close', res));
  await pipeline(child.stdout, zlib.createGzip({ level: 6 }), fs.createWriteStream(TAR));
  if ((await exitP) !== 0) throw new Error('save failed');
  console.log('  saved', fs.statSync(TAR).size, 'bytes');
  const conn = new Client();
  await new Promise((res, rej) => conn.on('ready', res).on('error', rej).connect({
    host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password,
    tryKeyboard: true, readyTimeout: 30000,
  }));
  const sftp = await new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))));
  await new Promise((res, rej) => sftp.fastPut(TAR, `${cfg.remoteDir}/mediamtx-new.tar.gz`, (e) => (e ? rej(e) : res())));
  sftp.end();
  console.log('> load & up');
  await new Promise((res, rej) => {
    conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
      if (err) return rej(err);
      stream.end(cfg.password + `\ncd ${cfg.remoteDir}\ndocker load -i mediamtx-new.tar.gz\ndocker compose up -d --remove-orphans\ndocker compose ps\nrm -f mediamtx-new.tar.gz\n`);
      stream.on('data', (d) => process.stdout.write(d));
      stream.stderr.on('data', (d) => process.stdout.write(d));
      stream.on('close', res);
    });
  });
  conn.end();
  console.log('done');
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
