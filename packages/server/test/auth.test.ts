import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { pinHash, signSession, verifySession, SESSION_COOKIE } from '../src/lib/auth.js';
import type { FastifyInstance } from 'fastify';

const here = dirname(fileURLToPath(import.meta.url));
const VIDEO_HTML = readFileSync(resolve(here, 'fixtures/video.html'), 'utf8');

const TEST_SECRET = 'test-secret-please-rotate-in-prod';
const TEST_PIN = '20264368';
const TEST_PIN_HASH = pinHash(TEST_PIN, TEST_SECRET);

function makeApp(): Promise<FastifyInstance> {
  return buildApp({
    logger: false,
    rateLimit: false,
    auth: {
      pinHashHex: TEST_PIN_HASH,
      hmacSecret: TEST_SECRET,
      sessionTtlMs: 60_000,
    },
    parseDeps: {
      resolveUrl: async (u) => u.replace('v.douyin.com', 'www.iesdouyin.com'),
      fetchPage: async () => VIDEO_HTML,
    },
  });
}

describe('auth lib', () => {
  it('pinHash is deterministic but secret-dependent', () => {
    const a = pinHash(TEST_PIN, 's1');
    const b = pinHash(TEST_PIN, 's2');
    expect(a).not.toEqual(b);
    expect(pinHash(TEST_PIN, 's1')).toEqual(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signSession + verifySession round-trip', () => {
    const tk = signSession(TEST_SECRET, 5_000);
    const payload = verifySession(tk, TEST_SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.exp).toBeGreaterThan(Date.now());
  });

  it('verifySession rejects forged signatures', () => {
    const tk = signSession(TEST_SECRET, 5_000);
    const tampered = tk.slice(0, -2) + (tk.endsWith('aa') ? 'bb' : 'aa');
    expect(verifySession(tampered, TEST_SECRET)).toBeNull();
  });

  it('verifySession rejects wrong secret', () => {
    const tk = signSession(TEST_SECRET, 5_000);
    expect(verifySession(tk, 'other-secret')).toBeNull();
  });

  it('verifySession rejects expired tokens', () => {
    const tk = signSession(TEST_SECRET, 1, Date.now() - 10_000);
    expect(verifySession(tk, TEST_SECRET)).toBeNull();
  });
});

describe('POST /api/auth/login', () => {
  it('rejects wrong pin with 401', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { pin: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('BAD_PIN');
    await app.close();
  });

  it('accepts correct pin and sets HttpOnly cookie', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { pin: TEST_PIN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '');
    expect(cookieStr).toContain(`${SESSION_COOKIE}=`);
    expect(cookieStr.toLowerCase()).toContain('httponly');
    expect(cookieStr.toLowerCase()).toContain('samesite=lax');
    await app.close();
  });

  it('rejects empty body with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('protected routes', () => {
  it('GET /api/health is open (no auth required)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('POST /api/parse without cookie returns 401', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/parse',
      payload: { url: 'https://v.douyin.com/iABCDEF/' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
    await app.close();
  });

  it('POST /api/parse with valid cookie returns 200', async () => {
    const app = await makeApp();
    const tk = signSession(TEST_SECRET, 60_000);
    const res = await app.inject({
      method: 'POST',
      url: '/api/parse',
      headers: { cookie: `${SESSION_COOKIE}=${tk}` },
      payload: { url: 'https://v.douyin.com/iABCDEF/' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.kind).toBe('video');
    await app.close();
  });

  it('POST /api/parse with forged cookie returns 401', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/parse',
      headers: { cookie: `${SESSION_COOKIE}=${signSession('not-the-secret', 60_000)}` },
      payload: { url: 'https://v.douyin.com/iABCDEF/' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET /api/download without cookie returns 401', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/download?url=https://aweme.snssdk.com/x.mp4',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /api/auth/state', () => {
  it('reports not authenticated without cookie', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(res.statusCode).toBe(200);
    expect(res.json().authenticated).toBe(false);
    await app.close();
  });

  it('reports authenticated with valid cookie', async () => {
    const app = await makeApp();
    const tk = signSession(TEST_SECRET, 60_000);
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/state',
      headers: { cookie: `${SESSION_COOKIE}=${tk}` },
    });
    expect(res.json().authenticated).toBe(true);
    await app.close();
  });
});
