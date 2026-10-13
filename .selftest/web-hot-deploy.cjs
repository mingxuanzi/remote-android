/* 仅重建并热部署 web 容器 */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const ROOT = path.join(__dirname, '..');

const TAG = 'remote-android-web:0.0.55';
const TAR = path.join(ROOT, '.publish', 'web-hot.tar.gz');

async function main() {
  console.log('> docker build web...');
  execSync(`docker build --pull=false -t ${TAG} ./web`, { cwd: ROOT, stdio: 'inherit' });
  console.log('> docker save (web only)...');
  const child = spawn('docker', ['save', TAG], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  const exitP = new Promise((res) => child.on('close', res));
  await pipeline(child.stdout, zlib.createGzip({ level: 6 }), fs.createWriteStream(TAR));
  if ((await exitP) !== 0) throw new Error('docker save failed');
  console.log('  saved', fs.statSync(TAR).size, 'bytes');
  const conn = new Client();
  await new Promise((res, rej) => conn.on('ready', res).on('error', rej).connect({
    host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password,
    tryKeyboard: true, readyTimeout: 30000,
  }));
  const sftp = await new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))));
  console.log('> upload...');
  await new Promise((res, rej) => sftp.fastPut(TAR, `${cfg.remoteDir}/web-hot.tar.gz`, (e) => (e ? rej(e) : res())));
  sftp.end();
  console.log('> load & recreate web...');
  await new Promise((res, rej) => {
    conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
      if (err) return rej(err);
      stream.end(cfg.password + `\ncd ${cfg.remoteDir}\ndocker load -i web-hot.tar.gz\ndocker compose up -d --force-recreate web 2>/dev/null || docker-compose up -d --force-recreate web\nrm -f web-hot.tar.gz\n`);
      stream.on('data', (d) => process.stdout.write(d));
      stream.stderr.on('data', (d) => process.stdout.write(d));
      stream.on('close', res);
    });
  });
  conn.end();
  console.log('done');
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
