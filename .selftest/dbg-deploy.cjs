/* 仅重建并热部署 api 容器(诊断用) */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Client } = require('ssh2');
const cfg = require('../publish.config.js');
const ROOT = path.join(__dirname, '..');

const TAG = 'remote-android-api:0.0.55';
const TAR = path.join(ROOT, '.publish', 'api-dbg.tar.gz');

async function main() {
  console.log('> docker build api...');
  execSync(`docker build --pull=false -t ${TAG} ./server`, { cwd: ROOT, stdio: 'inherit' });

  console.log('> docker save (api only)...');
  const child = require('child_process').spawn('docker', ['save', TAG], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  const exitP = new Promise((res) => child.on('close', res));
  await pipeline(child.stdout, zlib.createGzip({ level: 6 }), fs.createWriteStream(TAR));
  if ((await exitP) !== 0) throw new Error('docker save failed');
  console.log('  saved', TAR, fs.statSync(TAR).size, 'bytes');

  const conn = new Client();
  await new Promise((res, rej) => conn.on('ready', res).on('error', rej).connect({
    host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password,
    tryKeyboard: true, readyTimeout: 30000,
  }));
  const sftp = await new Promise((res, rej) => conn.sftp((e, s) => (e ? rej(e) : res(s))));
  console.log('> upload...');
  await new Promise((res, rej) => sftp.fastPut(TAR, `${cfg.remoteDir}/api-dbg.tar.gz`, (e) => (e ? rej(e) : res())));
  sftp.end();
  console.log('> load & recreate api...');
  await new Promise((res, rej) => {
    conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
      if (err) return rej(err);
      stream.end(cfg.password + `\ncd ${cfg.remoteDir}\ndocker load -i api-dbg.tar.gz\ndocker compose up -d --force-recreate api 2>/dev/null || docker-compose up -d --force-recreate api\nrm -f api-dbg.tar.gz\n`);
      stream.on('data', (d) => process.stdout.write(d));
      stream.stderr.on('data', (d) => process.stdout.write(d));
      stream.on('close', res);
    });
  });
  conn.end();
  console.log('done');
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
