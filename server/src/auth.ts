import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { UserRow, userStore, newId } from './db';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expect = Buffer.from(hash, 'hex');
  return candidate.length === expect.length && crypto.timingSafeEqual(candidate, expect);
}

export interface TokenPayload {
  uid: string;
  username: string;
  role: 'admin' | 'user';
}

export function signToken(user: UserRow): string {
  const payload: TokenPayload = { uid: user.id, username: user.username, role: user.role };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '7d' });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as TokenPayload;
  } catch {
    return null;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

/** Express 中间件:Bearer Token 鉴权 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = token ? verifyToken(token) : null;
  const user = payload ? userStore.get(payload.uid) : undefined;
  if (!user) {
    res.status(401).json({ error: '未登录或登录已过期' });
    return;
  }
  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}

/** 实例/模板可见性:admin 全量,普通用户仅自己的 */
export function canAccess(user: UserRow, ownerId: string): boolean {
  return user.role === 'admin' || ownerId === user.id;
}

/** 首次启动创建默认 admin(密码可用环境变量 ADMIN_PASSWORD 覆盖) */
export function ensureAdminUser(): void {
  if (userStore.getByUsername('admin')) return;
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  userStore.insert({
    id: newId(),
    username: 'admin',
    passwordHash: hashPassword(password),
    role: 'admin',
    maxInstances: 999,
  });
  console.log(`已创建默认管理员 admin(密码: ${process.env.ADMIN_PASSWORD ? '来自 ADMIN_PASSWORD' : 'admin123,请尽快修改'})`);
}
