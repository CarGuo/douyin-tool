import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  verifyPin,
  hasValidUnlockToken,
  persistUnlock,
  forgetUnlock,
  recordFailure,
  lockoutRemainingMs,
  failureCount,
  logout,
} from '../src/lib/pinSecurity';

function mockFetchOnce(opts: { status: number; body?: unknown; headers?: Record<string, string> }) {
  const headers = new Headers(opts.headers ?? {});
  const fn = vi.fn().mockResolvedValue({
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    headers,
    json: async () => opts.body ?? {},
  } as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('pinSecurity (server-authoritative)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('verifyPin sends pin to /api/auth/login with credentials', async () => {
    const fetchMock = mockFetchOnce({ status: 200, body: { ok: true, exp: Date.now() + 1000 } });
    const res = await verifyPin('20264368');
    expect(res.ok).toBe(true);
    expect(typeof res.exp).toBe('number');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body as string)).toEqual({ pin: '20264368' });
  });

  it('verifyPin returns ok:false on 401', async () => {
    mockFetchOnce({ status: 401, body: { ok: false, message: '密码不正确' } });
    const res = await verifyPin('11111111');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.message).toBe('密码不正确');
  });

  it('verifyPin maps 429 to retryAfterMs', async () => {
    mockFetchOnce({ status: 429, body: { ok: false }, headers: { 'retry-after': '42' } });
    const res = await verifyPin('11111111');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(429);
    expect(res.retryAfterMs).toBe(42_000);
  });

  it('verifyPin rejects empty input without hitting network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await verifyPin('');
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('persistUnlock + hasValidUnlockToken round-trip with explicit exp', () => {
    expect(hasValidUnlockToken()).toBe(false);
    persistUnlock(Date.now() + 60_000);
    expect(hasValidUnlockToken()).toBe(true);
    forgetUnlock();
    expect(hasValidUnlockToken()).toBe(false);
  });

  it('hasValidUnlockToken returns false if exp already passed', () => {
    persistUnlock(Date.now() - 1);
    expect(hasValidUnlockToken()).toBe(false);
  });

  it('hasValidUnlockToken rejects non-numeric or short value', () => {
    localStorage.setItem('dy.gate.exp', 'banana');
    expect(hasValidUnlockToken()).toBe(false);
    localStorage.setItem('dy.gate.exp', '');
    expect(hasValidUnlockToken()).toBe(false);
  });

  it('recordFailure escalates lockout per ladder', () => {
    expect(failureCount()).toBe(0);
    expect(lockoutRemainingMs()).toBe(0);

    recordFailure();
    expect(lockoutRemainingMs()).toBe(0);
    recordFailure();
    expect(lockoutRemainingMs()).toBe(0);

    const s3 = recordFailure();
    expect(s3.count).toBe(3);
    expect(s3.lockedUntil - Date.now()).toBeGreaterThan(4_000);
    expect(s3.lockedUntil - Date.now()).toBeLessThanOrEqual(5_000);
    expect(lockoutRemainingMs()).toBeGreaterThan(0);

    recordFailure();
    recordFailure();
    const s6 = recordFailure();
    expect(s6.count).toBe(6);
    expect(s6.lockedUntil - Date.now()).toBeGreaterThan(29_000);
  });

  it('persistUnlock clears the failure counter', () => {
    recordFailure();
    recordFailure();
    expect(failureCount()).toBe(2);
    persistUnlock(Date.now() + 60_000);
    expect(failureCount()).toBe(0);
  });

  it('logout clears local hint and calls /api/auth/logout', async () => {
    const fetchMock = mockFetchOnce({ status: 200, body: { ok: true } });
    persistUnlock(Date.now() + 60_000);
    expect(hasValidUnlockToken()).toBe(true);
    await logout();
    expect(hasValidUnlockToken()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/logout');
  });
});
