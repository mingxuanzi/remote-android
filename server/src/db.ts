import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config';

/** 实例台账记录(Docker 容器名 = name) */
export interface InstanceRow {
  id: string;
  name: string;
  image: string;
  width: number;
  height: number;
  dpi: number;
  gpuMode: 'host' | 'guest';
  /** 方向锁定:natural=设备自然方向, landscape=强制横屏, portrait=强制竖屏 */
  orientation: 'natural' | 'landscape' | 'portrait';
  /** CPU 核心数 / 内存 MB(容器级限制) */
  cpus: number;
  memoryMb: number;
  ownerId: string; // 归属用户,'' = 系统/迁移前遗留(仅 admin 可见)
  /** 运行状态;starting/stopping/restarting 为过渡态(操作已受理、容器尚未落定) */
  status: 'creating' | 'starting' | 'stopping' | 'restarting' | 'running' | 'stopped' | 'error';
  message: string;
  createdAt: number;
}

/** 实例快照模板(docker commit 产物) */
export interface TemplateRow {
  id: string;
  name: string;
  imageRef: string;
  width: number;
  height: number;
  dpi: number;
  gpuMode: 'host' | 'guest';
  cpus: number;
  memoryMb: number;
  sourceInstance: string;
  note: string;
  ownerId: string;
  createdAt: number;
}

/** 用户 */
export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin' | 'user';
  maxInstances: number;
  createdAt: number;
}

let db: Database.Database;

export function initDb(): void {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id        TEXT PRIMARY KEY,
      name      TEXT UNIQUE NOT NULL,
      image     TEXT NOT NULL,
      width     INTEGER NOT NULL,
      height    INTEGER NOT NULL,
      dpi       INTEGER NOT NULL,
      gpuMode   TEXT NOT NULL DEFAULT 'guest',
      status    TEXT NOT NULL DEFAULT 'creating',
      message   TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS templates (
      id             TEXT PRIMARY KEY,
      name           TEXT UNIQUE NOT NULL,
      imageRef       TEXT NOT NULL,
      width          INTEGER NOT NULL,
      height         INTEGER NOT NULL,
      dpi            INTEGER NOT NULL,
      gpuMode        TEXT NOT NULL DEFAULT 'guest',
      sourceInstance TEXT NOT NULL DEFAULT '',
      note           TEXT NOT NULL DEFAULT '',
      ownerId        TEXT NOT NULL DEFAULT '',
      createdAt      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      username     TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'user',
      maxInstances INTEGER NOT NULL DEFAULT 5,
      createdAt    INTEGER NOT NULL
    );
  `);
  migrate();
}

/** 老库兼容:instances 补 ownerId / orientation / cpus / memoryMb 列,templates 补 cpus / memoryMb */
function migrate(): void {
  const cols = db.prepare(`PRAGMA table_info(instances)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'ownerId')) {
    db.exec(`ALTER TABLE instances ADD COLUMN ownerId TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.some((c) => c.name === 'orientation')) {
    db.exec(`ALTER TABLE instances ADD COLUMN orientation TEXT NOT NULL DEFAULT 'natural'`);
  }
  if (!cols.some((c) => c.name === 'cpus')) {
    db.exec(`ALTER TABLE instances ADD COLUMN cpus INTEGER NOT NULL DEFAULT 2`);
  }
  if (!cols.some((c) => c.name === 'memoryMb')) {
    db.exec(`ALTER TABLE instances ADD COLUMN memoryMb INTEGER NOT NULL DEFAULT 2048`);
  }
  const tcols = db.prepare(`PRAGMA table_info(templates)`).all() as { name: string }[];
  if (!tcols.some((c) => c.name === 'cpus')) {
    db.exec(`ALTER TABLE templates ADD COLUMN cpus INTEGER NOT NULL DEFAULT 2`);
  }
  if (!tcols.some((c) => c.name === 'memoryMb')) {
    db.exec(`ALTER TABLE templates ADD COLUMN memoryMb INTEGER NOT NULL DEFAULT 2048`);
  }
}

const now = () => Date.now();
export const newId = () => crypto.randomBytes(4).toString('hex');

export const instanceStore = {
  insert(row: Omit<InstanceRow, 'createdAt'>): InstanceRow {
    const full: InstanceRow = { ...row, createdAt: now() };
    db.prepare(
      `INSERT INTO instances (id, name, image, width, height, dpi, gpuMode, orientation, cpus, memoryMb, ownerId, status, message, createdAt)
       VALUES (@id, @name, @image, @width, @height, @dpi, @gpuMode, @orientation, @cpus, @memoryMb, @ownerId, @status, @message, @createdAt)`,
    ).run(full);
    return full;
  },
  list(): InstanceRow[] {
    return db.prepare('SELECT * FROM instances ORDER BY createdAt DESC').all() as InstanceRow[];
  },
  listByOwner(ownerId: string): InstanceRow[] {
    return db.prepare('SELECT * FROM instances WHERE ownerId = ? ORDER BY createdAt DESC').all(ownerId) as InstanceRow[];
  },
  countByOwner(ownerId: string): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM instances WHERE ownerId = ?').get(ownerId) as { n: number }).n;
  },
  get(id: string): InstanceRow | undefined {
    return db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as InstanceRow | undefined;
  },
  getByName(name: string): InstanceRow | undefined {
    return db.prepare('SELECT * FROM instances WHERE name = ?').get(name) as InstanceRow | undefined;
  },
  setStatus(id: string, status: InstanceRow['status'], message = ''): void {
    db.prepare('UPDATE instances SET status = ?, message = ? WHERE id = ?').run(status, message, id);
  },

  setOrientation(id: string, orientation: InstanceRow['orientation']): void {
    db.prepare('UPDATE instances SET orientation = ? WHERE id = ?').run(orientation, id);
  },
  remove(id: string): void {
    db.prepare('DELETE FROM instances WHERE id = ?').run(id);
  },
};

export const templateStore = {
  insert(row: Omit<TemplateRow, 'createdAt'>): TemplateRow {
    const full: TemplateRow = { ...row, createdAt: now() };
    db.prepare(
      `INSERT INTO templates (id, name, imageRef, width, height, dpi, gpuMode, cpus, memoryMb, sourceInstance, note, ownerId, createdAt)
       VALUES (@id, @name, @imageRef, @width, @height, @dpi, @gpuMode, @cpus, @memoryMb, @sourceInstance, @note, @ownerId, @createdAt)`,
    ).run(full);
    return full;
  },
  list(): TemplateRow[] {
    return db.prepare('SELECT * FROM templates ORDER BY createdAt DESC').all() as TemplateRow[];
  },
  get(id: string): TemplateRow | undefined {
    return db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
  },
  getByName(name: string): TemplateRow | undefined {
    return db.prepare('SELECT * FROM templates WHERE name = ?').get(name) as TemplateRow | undefined;
  },
  remove(id: string): void {
    db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  },
};

export const userStore = {
  insert(row: Omit<UserRow, 'createdAt'>): UserRow {
    const full: UserRow = { ...row, createdAt: now() };
    db.prepare(
      `INSERT INTO users (id, username, passwordHash, role, maxInstances, createdAt)
       VALUES (@id, @username, @passwordHash, @role, @maxInstances, @createdAt)`,
    ).run(full);
    return full;
  },
  list(): UserRow[] {
    return db.prepare('SELECT * FROM users ORDER BY createdAt ASC').all() as UserRow[];
  },
  get(id: string): UserRow | undefined {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  },
  getByUsername(username: string): UserRow | undefined {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  },
  update(id: string, patch: Partial<Pick<UserRow, 'passwordHash' | 'maxInstances' | 'role'>>): void {
    const fields = Object.keys(patch) as (keyof typeof patch)[];
    if (!fields.length) return;
    const sql = `UPDATE users SET ${fields.map((f) => `${f} = @${f}`).join(', ')} WHERE id = @id`;
    db.prepare(sql).run({ ...patch, id });
  },
  remove(id: string): void {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  },
};
