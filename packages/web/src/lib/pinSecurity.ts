/**
 * pinSecurity.ts (v2 — server-authoritative)
 *
 * Threat model:
 *   The PIN is checked **on the server** via /api/auth/login. The server then
 *   issues a signed, HttpOnly, Secure session cookie that the browser cannot
 *   read or modify from JavaScript. Forged tokens are rejected by the server's
 *   HMAC, so localStorage tampering does NOT grant access to /api/parse or
 *   /api/download. Brute force is mitigated server-side by @fastify/rate-limit
 *   (login: 5/min/IP) — see packages/server/src/app.ts.
 *
 * What the browser still does:
 *   1. Adds a small client-side lockout countdown (UX only, also helps offline).
 *   2. Caches an *opaque* "session expiry" timestamp in localStorage so we can
 *      decide whether to skip the gate UI on next visit. This is purely a hint
 *      — even if the user fakes it, the server still gates every API call.
 */
const STORAGE_EXP = 'dy.gate.exp';
const STORAGE_FAILS = 'dy.gate.fl';

export const PIN_LENGTH = 8;

const LOCKOUT_LADDER_MS = [
  0, 0, 0,
  5_000,
  5_000,
  10_000,
  30_000,
  60_000,
  120_000,
  300_000,
];

const RAW_BASE: string =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL) || '/';
const BASE = RAW_BASE.endsWith('/') ? RAW_BASE.slice(0, -1) : RAW_BASE;

export interface VerifyResult {
  ok: boolean;
  status: number;
  exp?: number;
  retryAfterMs?: number;
  message?: string;
}

/**
 * Send the PIN to the server. Cookie is set via Set-Cookie if ok.
 * Caller must use credentials: 'include' implicitly via this helper.
 */
export async function verifyPin(input: string): Promise<VerifyResult> {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, status: 400, message: 'empty pin' };
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: input }),
    });
  } catch (err) {
    return { ok: false, status: 0, message: (err as Error).message };
  }
  let body: { ok?: boolean; exp?: number; message?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after') ?? '0');
    return { ok: false, status: 429, retryAfterMs: ra > 0 ? ra * 1000 : 30_000, message: '请求过于频繁' };
  }
  if (res.ok && body?.ok) {
    return { ok: true, status: 200, exp: body.exp };
  }
  return { ok: false, status: res.status, message: body?.message };
}

/** Cache only the session-expiry hint (cookie is the real thing). */
export function persistUnlock(exp?: number): void {
  try {
    if (typeof exp === 'number') {
      if (exp > Date.now()) {
        localStorage.setItem(STORAGE_EXP, String(exp));
      } else {
        localStorage.removeItem(STORAGE_EXP);
      }
    } else {
      localStorage.setItem(STORAGE_EXP, String(Date.now() + 30 * 24 * 60 * 60 * 1000));
    }
    localStorage.removeItem(STORAGE_FAILS);
  } catch {
    /* ignore */
  }
}

/**
 * UI-only hint: should we skip rendering the keypad on this visit?
 * The server is still authoritative; if the cookie is missing the very next
 * /api/parse call returns 401 and the gate flips back to locked.
 */
export function hasValidUnlockToken(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_EXP);
    if (!raw) return false;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export function forgetUnlock(): void {
  try {
    localStorage.removeItem(STORAGE_EXP);
    localStorage.removeItem(STORAGE_FAILS);
  } catch {
    /* ignore */
  }
}

interface FailState {
  count: number;
  lockedUntil: number;
}

function readFailState(): FailState {
  try {
    const raw = localStorage.getItem(STORAGE_FAILS);
    if (!raw) return { count: 0, lockedUntil: 0 };
    const obj = JSON.parse(raw);
    if (typeof obj?.count === 'number' && typeof obj?.lockedUntil === 'number') return obj;
  } catch {
    /* ignore */
  }
  return { count: 0, lockedUntil: 0 };
}

function writeFailState(s: FailState): void {
  try {
    localStorage.setItem(STORAGE_FAILS, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function recordFailure(now: number = Date.now()): FailState {
  const prev = readFailState();
  const count = prev.count + 1;
  const idx = Math.min(count, LOCKOUT_LADDER_MS.length - 1);
  const lockoutMs = LOCKOUT_LADDER_MS[idx];
  const lockedUntil = lockoutMs > 0 ? now + lockoutMs : 0;
  const next: FailState = { count, lockedUntil };
  writeFailState(next);
  return next;
}

export function lockoutRemainingMs(now: number = Date.now()): number {
  const s = readFailState();
  return s.lockedUntil > now ? s.lockedUntil - now : 0;
}

export function failureCount(): number {
  return readFailState().count;
}

export async function logout(): Promise<void> {
  forgetUnlock();
  try {
    await fetch(`${BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {
    /* ignore */
  }
}

export const __test = {
  STORAGE_EXP,
  STORAGE_FAILS,
  LOCKOUT_LADDER_MS,
  readFailState,
  writeFailState,
};
