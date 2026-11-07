import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../db';
import { apiTokens, sessions, users } from '../db/schema';
import type { Role, Theme } from '@sixpoint/shared';

export const SESSION_COOKIE = 'sp_sid';
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;
/** Renew the session at most once an hour (sliding expiry, R-10). */
const RENEW_AFTER_MS = 3600 * 1000;

// argon2id (Algorithm.Argon2id === 2) with OWASP-recommended parameters
const ARGON = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(pw: string) {
  return hash(pw, ARGON);
}
export async function verifyPassword(stored: string, pw: string) {
  try {
    return await verify(stored, pw);
  } catch {
    return false;
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (n = 32) => randomBytes(n).toString('base64url');

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  theme: Theme;
  via: 'session' | 'token';
  csrf?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
    clientId: string | null;
  }
}

export async function createSession(db: DB, userId: string) {
  const raw = randomToken();
  const csrf = randomToken(18);
  const expiresAt = new Date(Date.now() + SESSION_MS);
  await db.insert(sessions).values({ id: sha256(raw), userId, csrf, expiresAt });
  return { raw, csrf, expiresAt };
}

export async function resolveSession(
  db: DB,
  raw: string,
): Promise<{ user: AuthUser; sid: string; renew: boolean } | null> {
  const sid = sha256(raw);
  const rows = await db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sid), gt(sessions.expiresAt, new Date()), eq(users.active, true)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const renew = r.s.expiresAt.getTime() - Date.now() < SESSION_MS - RENEW_AFTER_MS;
  if (renew) {
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + SESSION_MS) })
      .where(eq(sessions.id, sid));
  }
  return {
    sid,
    renew,
    user: {
      id: r.u.id,
      email: r.u.email,
      name: r.u.name,
      role: r.u.role,
      theme: r.u.theme,
      via: 'session',
      csrf: r.s.csrf,
    },
  };
}

/** Read-only API tokens for scripts (POST /api/tokens). They act as a Viewer. */
export async function resolveToken(db: DB, raw: string): Promise<AuthUser | null> {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, sha256(raw)), isNull(apiTokens.revokedAt)))
    .limit(1);
  const t = rows[0];
  if (!t) return null;
  return {
    id: t.createdBy ?? t.id,
    email: '',
    name: `Token: ${t.name}`,
    role: 'viewer',
    theme: 'system',
    via: 'token',
  };
}

export async function purgeExpiredSessions(db: DB) {
  await db.delete(sessions).where(sql`${sessions.expiresAt} < now()`);
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Server-side role enforcement (R-13). Use as a preHandler. */
export function requireRole(min: Role) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) throw new HttpError(401, 'Sign in required');
    if (RANK[req.user.role] < RANK[min]) throw new HttpError(403, `Requires ${min} role`);
  };
}

export const requireUser = requireRole('viewer');

/* ---------- sign-in lockout (R-14) ---------- */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

export class LoginLimiter {
  private fails = new Map<string, { count: number; first: number; lockedUntil: number }>();

  private key(kind: 'email' | 'ip', v: string) {
    return `${kind}:${v.toLowerCase()}`;
  }

  lockedFor(email: string, ip: string): number {
    const now = Date.now();
    let max = 0;
    for (const k of [this.key('email', email), this.key('ip', ip)]) {
      const e = this.fails.get(k);
      if (e && e.lockedUntil > now) max = Math.max(max, e.lockedUntil - now);
    }
    return max;
  }

  fail(email: string, ip: string) {
    const now = Date.now();
    for (const k of [this.key('email', email), this.key('ip', ip)]) {
      let e = this.fails.get(k);
      if (!e || now - e.first > WINDOW_MS) e = { count: 0, first: now, lockedUntil: 0 };
      e.count++;
      if (e.count >= MAX_FAILS) e.lockedUntil = now + WINDOW_MS;
      this.fails.set(k, e);
    }
  }

  succeed(email: string) {
    this.fails.delete(this.key('email', email));
  }

  sweep() {
    const now = Date.now();
    for (const [k, e] of this.fails)
      if (now - e.first > WINDOW_MS && e.lockedUntil < now) this.fails.delete(k);
  }
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
