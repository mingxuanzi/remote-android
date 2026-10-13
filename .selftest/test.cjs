/* RemoteAndroid 端到端自测:无头 Chrome 真浏览器
 * 登录 → 投屏(WebRTC)→ 验视频 → 切横屏 → 复验 → 切回竖屏 → 复验 */
const puppeteer = require('puppeteer-core');
const { Client } = require('ssh2');
const fs = require('fs');
const cfg = require('../publish.config.js');

const HOST = process.env.RA_HOST || cfg.host || '127.0.0.1';
const BASE = `https://${HOST}:8443`;
const API = `http://${HOST}:8443`; // node 侧 API 走 HTTP,绕开自签证书校验
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function sshNode(code) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      const b64 = Buffer.from(code).toString('base64');
      conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
        if (err) return reject(err);
        stream.end(cfg.password + `\necho ${b64} | docker exec -i ra-api sh -c 'base64 -d | node'\n`);
        let out = '';
        stream.on('data', (d) => { out += d; });
        stream.on('close', () => { conn.end(); resolve(out); });
      });
    });
    conn.on('error', reject);
    conn.connect({
      host: cfg.host, port: cfg.port, username: cfg.username,
      password: cfg.password, tryKeyboard: true, readyTimeout: 15000
    });
  });
}

const userCode = (del) => `
const Database = require('better-sqlite3');
const crypto = require('crypto');
const db = new Database('/app/data/remote-android.db');
const u = db.prepare('SELECT id FROM users WHERE username = ?').get('smoketest');
if (${del}) { if (u) db.prepare('DELETE FROM users WHERE id = ?').run(u.id); }
else if (!u) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('smoke123456', salt, 64).toString('hex');
  db.prepare('INSERT INTO users (id, username, passwordHash, role, maxInstances, createdAt) VALUES (?,?,?,?,?,?)')
    .run(crypto.randomBytes(4).toString('hex'), 'smoketest', salt + ':' + hash, 'admin', 999, Date.now());
}
console.log('ok');
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitVideo(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      return { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, paused: v.paused, ready: v.readyState };
    });
    if (info && info.w > 0 && info.t > 0.2) return info;
    await sleep(1000);
  }
  return null;
}

async function clickOrientation(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => /横屏|竖屏|自然/.test(x.textContent) && x.textContent.length < 8);
    if (!b) return null;
    const label = b.textContent.trim();
    b.click();
    return label;
  });
}

async function main() {
  await sshNode(userCode(false));
  console.log('[1/6] 冒烟用户已建,取 test1 实例 id...');
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'smoketest', password: 'smoke123456' }),
  });
  const { token } = await login.json();
  const inst = await (await fetch(`${API}/api/instances`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const test1 = inst.find((i) => i.name === 'test1');
  if (!test1) throw new Error('test1 不存在');
  console.log('  test1:', test1.id, test1.status, test1.orientation);

  // 统一初始方向为 natural,保证断言序列确定
  if (test1.orientation !== 'natural') {
    await fetch(`${API}/api/instances/${test1.id}/orientation`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orientation: 'natural' }),
    });
    console.log('  已重置方向为 natural');
    await sleep(3000);
  }

  console.log('[2/6] 启动无头 Chrome 并登录...');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1400,1000',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: { width: 1400, height: 1000 },
  });
  const page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.type('input[placeholder="用户名"]', 'smoketest');
  await page.type('input[placeholder="密码"]', 'smoke123456');
  await page.click('button.el-button--primary');
  await page.waitForFunction(() => location.pathname === '/', { timeout: 15000 });
  console.log('  登录成功');

  console.log('[3/6] 直达投屏页 /instance/' + test1.id + ' ...');
  await page.goto(`${BASE}/instance/${test1.id}`, { waitUntil: 'networkidle2', timeout: 30000 });

  console.log('[4/6] 等待 WebRTC 视频出图(竖屏预期 720x1280)...');
  const v1 = await waitVideo(page, 45000);
  console.log('  视频状态:', JSON.stringify(v1));
  await page.screenshot({ path: 'shot-1-portrait.png' });

  console.log('[5/6] 点击方向按钮 → 横屏...');
  const before = await clickOrientation(page);
  console.log('  点击前状态:', before);
  await sleep(4000);
  const v2 = await waitVideo(page, 45000);
  console.log('  切换后视频状态:', JSON.stringify(v2));
  await page.screenshot({ path: 'shot-2-landscape.png' });

  console.log('[6/6] 再切回竖屏...');
  const before2 = await clickOrientation(page);
  console.log('  点击前状态:', before2);
  await sleep(4000);
  const v3 = await waitVideo(page, 45000);
  console.log('  切回后视频状态:', JSON.stringify(v3));
  await page.screenshot({ path: 'shot-3-back.png' });

  const ok = v1 && v1.w === 720 && v2 && v2.w === 1280 && v3 && v3.w === 720;
  console.log(`\n===== 结论: ${ok ? '✅ 全部通过' : '❌ 未达标'} =====`);
  console.log(`竖屏=${v1 ? `${v1.w}x${v1.h}` : 'N/A'} → 横屏=${v2 ? `${v2.w}x${v2.h}` : 'N/A'} → 切回=${v3 ? `${v3.w}x${v3.h}` : 'N/A'}`);

  await browser.close();
  await sshNode(userCode(true));
  console.log('冒烟用户已清理');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
