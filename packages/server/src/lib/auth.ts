import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'dy_sess';
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SLIDING_RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface AuthConfig {
  pinHashHex: string;
  hmacSecret: string;
  sessionTtlMs: number;
}

export class AuthMisconfigured extends Error {
  code = 'AUTH_MISCONFIGURED';
}

function fromHex(hex: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new AuthMisconfigured(`invalid hex string (length=${hex.length})`);
  }
  return Buffer.from(hex, 'hex');
}

function constantTimeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function pinHash(pin: string, secret: string): string {
  return createHmac('sha256', secret).update(pin, 'utf8').digest('hex');
}

export function verifyPinAgainstHash(input: string, expectedHex: string, secret: string): boolean {
  if (typeof input !== 'string' || input.length === 0 || input.length > 64) return false;
  const got = pinHash(input, secret);
  try {
    return constantTimeEqualBuf(fromHex(got), fromHex(expectedHex));
  } catch {
    return false;
  }
}

export interface SessionPayload {
  exp: number;
  jti: string;
}

export function signSession(secret: string, ttlMs: number, now: number = Date.now()): string {
  const exp = now + ttlMs;
  const jti = randomBytes(8).toString('hex');
  const body = `${exp}.${jti}`;
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `${body}.${sig}`;
}

export function verifySession(
  token: string | undefined,
  secret: string,
  now: number = Date.now(),
): SessionPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [expStr, jti, sig] = parts;
  if (!/^\d+$/.test(expStr) || !/^[0-9a-f]+$/.test(jti) || !/^[0-9a-f]+$/.test(sig)) return null;
  const body = `${expStr}.${jti}`;
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  let ok = false;
  try {
    ok = constantTimeEqualBuf(fromHex(sig), fromHex(expected));
  } catch {
    return null;
  }
  if (!ok) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now) return null;
  return { exp, jti };
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const pinHashHex = (env.PIN_HASH ?? '').trim();
  const hmacSecret = (env.AUTH_SECRET ?? '').trim();
  if (!pinHashHex || pinHashHex.length < 32) {
    throw new AuthMisconfigured('PIN_HASH env is required (hex of HMAC-SHA256(secret, pin))');
  }
  if (!hmacSecret || hmacSecret.length < 16) {
    throw new AuthMisconfigured('AUTH_SECRET env is required (>= 16 chars)');
  }
  const ttlMs = Number(env.SESSION_TTL_MS ?? DEFAULT_SESSION_TTL_MS);
  return {
    pinHashHex,
    hmacSecret,
    sessionTtlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_SESSION_TTL_MS,
  };
}
