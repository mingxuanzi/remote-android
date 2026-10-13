/* 复现:PATCH 方向 → rtc/start → WHEP 探测 → 抓日志 */
const { Client } = require('ssh2')
const cfg = require('../publish.config.js')
const BASE = process.env.RA_BASE || `http://${cfg.host}:8443`

function sshNode(code) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn.on('ready', () => {
      const b64 = Buffer.from(code).toString('base64')
      conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
        if (err) return reject(err)
        stream.end(cfg.password + `\necho ${b64} | docker exec -i ra-api sh -c 'base64 -d | node'\n`)
        let out = ''
        stream.on('data', (d) => { out += d })
        stream.on('close', () => { conn.end(); resolve(out) })
      })
    })
    conn.on('error', reject)
    conn.connect({
      host: cfg.host, port: cfg.port, username: cfg.username,
      password: cfg.password, tryKeyboard: true, readyTimeout: 15000
    })
  })
}
function sshShell(cmd) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn.on('ready', () => {
      conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
        if (err) return reject(err)
        stream.end(cfg.password + '\n' + cmd + '\n')
        let out = ''
        stream.on('data', (d) => { out += d })
        stream.on('close', () => { conn.end(); resolve(out) })
      })
    })
    conn.on('error', reject)
    conn.connect({
      host: cfg.host, port: cfg.port, username: cfg.username,
      password: cfg.password, tryKeyboard: true, readyTimeout: 15000
    })
  })
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
`

async function main() {
  await sshNode(userCode(false))
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.RA_SMOKE_USER || 'smoketest', password: process.env.RA_SMOKE_PASSWORD || '' })
  })
  const { token } = await login.json()
  const auth = { Authorization: `Bearer ${token}` }
  const inst = await (await fetch(`${BASE}/api/instances`, { headers: auth })).json()
  const test1 = inst.find((i) => i.name === 'test1')
  console.log('test1:', test1.id, 'orientation:', test1.orientation)

  console.log('PATCH → landscape...')
  const p = await fetch(`${BASE}/api/instances/${test1.id}/orientation`, {
    method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orientation: 'landscape' })
  })
  console.log('PATCH:', p.status, await p.text())

  console.log('rtc/start...')
  const rtc = await fetch(`${BASE}/api/instances/${test1.id}/rtc/start`, {
    method: 'POST', headers: auth
  })
  console.log('rtc/start:', rtc.status, await rtc.text())

  await new Promise((r) => setTimeout(r, 6000))
  const probe = await fetch(`${BASE}/ra-${test1.id}/whep`, {
    method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\r\n'
  })
  console.log('WHEP 探测:', probe.status)

  console.log('--- ra-api 日志 ---')
  console.log((await sshShell('docker logs --tail 20 ra-api 2>&1')).trim())
  await sshNode(userCode(true))
}
main().catch((e) => { console.error(e); process.exit(1) })
