export type AwemeKind = 'video' | 'image' | 'unknown';

export interface ParsedAweme {
  kind: AwemeKind;
  awemeId: string;
  desc: string;
  author: { nickname: string; uid?: string; avatar?: string };
  cover?: string;
  video?: { playUrl: string; playUrlNoWatermark: string; duration?: number };
  images?: Array<{ url: string; width?: number; height?: number }>;
  music?: { title?: string; author?: string; playUrl?: string };
}

export interface MirrorEcho {
  enabled: boolean;
  /** Whether the server is set to auto-warm-up on every parse. Default false. */
  autoMirror?: boolean;
  ttlMinutes?: number;
  provider?: string;
}

export interface ParseSuccess {
  ok: true;
  data: ParsedAweme;
  /** Optional mirror config echo from server. */
  mirror?: MirrorEcho;
}
export interface ParseFailure {
  ok: false;
  code: string;
  message: string;
}

// Vite injects import.meta.env.BASE_URL based on `base` in vite.config.
// In dev / root deployment this is '/'; behind a sub-path reverse proxy
// (e.g. https://example.com/dy/) it becomes '/dy/'. We strip the trailing
// slash so we can build paths like `${BASE}/api/parse`.
const RAW_BASE: string =
  (typeof import.meta !== 'undefined' && (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL) || '/';
const BASE = RAW_BASE.endsWith('/') ? RAW_BASE.slice(0, -1) : RAW_BASE;

export async function parseLink(url: string): Promise<ParseSuccess | ParseFailure> {
  const res = await fetch(`${BASE}/api/parse`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (res.status === 401) {
    return { ok: false, code: 'UNAUTHENTICATED', message: '登录已过期，请重新输入密码' };
  }
  if (res.status === 429) {
    return { ok: false, code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' };
  }
  const body = (await res.json()) as ParseSuccess | ParseFailure;
  return body;
}

export function downloadProxyUrl(target: string, filename: string): string {
  const params = new URLSearchParams({ url: target, filename });
  return `${BASE}/api/download?${params.toString()}`;
}

// Inline-proxied URL for use as <video src> / <img src>. Avoids Douyin's
// Referer hot-link rejection (which renders a broken-image icon for the
// video element when the browser fetches the CDN URL directly).
export function inlineProxyUrl(target: string): string {
  const params = new URLSearchParams({ url: target, inline: '1' });
  return `${BASE}/api/download?${params.toString()}`;
}

/**
 * Ask the server to do a HEAD (with Range fallback) against the upstream
 * Douyin CDN URL and report the byte size. We use this to surface a
 * "12.4 MB" hint on the direct-download buttons before the user commits.
 *
 * Returns 0 when the size is unknown (CDN doesn't expose Content-Length on
 * HEAD and refuses the Range fallback) or the request errors out — callers
 * should treat 0 as "no hint available" and render the button without a
 * size label rather than as "0 B".
 */
export async function probeSize(targetUrl: string): Promise<number> {
  try {
    const params = new URLSearchParams({ url: targetUrl });
    const res = await fetch(`${BASE}/api/probe?${params.toString()}`, {
      credentials: 'include',
    });
    if (!res.ok) return 0;
    const body = (await res.json()) as { ok?: boolean; size?: number };
    return typeof body?.size === 'number' && body.size > 0 ? body.size : 0;
  } catch {
    return 0;
  }
}

export type MirrorKind = 'video' | 'cover' | 'image' | 'music';

export interface MirrorStatusResponse {
  ok: true;
  ready: boolean;
  state: 'idle' | 'fetching' | 'ready' | 'error';
  url?: string;
  objectKey?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface MirrorDisabledResponse {
  ok: false;
  code?: string;
  message?: string;
}

/**
 * Query the OSS mirror status for a given media object. When `srcUrl` is
 * supplied, the server will (re-)kick a fetch if the entry is idle. Returns
 * `{ ready:true, url }` once the cloud-fetch has finished and we have a
 * signed direct URL good for OSS_OBJECT_TTL_MINUTES minutes.
 *
 * Returns `null` when mirroring is disabled on the server (the frontend
 * should then fall back to the inline /api/download proxy).
 */
export async function fetchMirrorStatus(args: {
  awemeId: string;
  kind: MirrorKind;
  index?: number;
  srcUrl?: string;
  filename?: string;
}): Promise<MirrorStatusResponse | null> {
  const params = new URLSearchParams();
  params.set('awemeId', args.awemeId);
  params.set('kind', args.kind);
  if (typeof args.index === 'number') params.set('index', String(args.index));
  if (args.srcUrl) params.set('srcUrl', args.srcUrl);
  if (args.filename) params.set('filename', args.filename);
  const res = await fetch(`${BASE}/api/mirror?${params.toString()}`, {
    credentials: 'include',
  });
  if (res.status === 404) return null; // OSS disabled
  if (!res.ok) return null;
  const body = (await res.json()) as MirrorStatusResponse | MirrorDisabledResponse;
  if (!body.ok) return null;
  return body;
}

export interface MirrorTestSuccess {
  ok: true;
  url: string;
  objectKey: string;
  elapsedMs: number;
  provider?: string;
  ttlMinutes?: number;
}

export interface MirrorTestFailure {
  ok: false;
  code?: string;
  message: string;
  elapsedMs?: number;
  objectKey?: string;
  status?: number;
}

/**
 * Manually trigger a single end-to-end mirror upload + sign cycle. Blocks
 * until the OSS provider has confirmed the object is present (or the cycle
 * fails). Use to verify the pipeline before turning on OSS_AUTO_MIRROR.
 */
export async function testMirrorUpload(args: {
  srcUrl: string;
  kind: MirrorKind;
  awemeId?: string;
  index?: number;
  filename?: string;
}): Promise<MirrorTestSuccess | MirrorTestFailure> {
  const res = await fetch(`${BASE}/api/mirror/test`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, message: `HTTP ${res.status}`, status: res.status };
  }
  if (res.ok && body && typeof body === 'object' && (body as MirrorTestSuccess).ok) {
    return body as MirrorTestSuccess;
  }
  if (body && typeof body === 'object') {
    const b = body as Partial<MirrorTestFailure> & { message?: string; code?: string };
    return {
      ok: false,
      code: b.code,
      message: b.message || `HTTP ${res.status}`,
      elapsedMs: typeof b.elapsedMs === 'number' ? b.elapsedMs : undefined,
      objectKey: typeof b.objectKey === 'string' ? b.objectKey : undefined,
      status: res.status,
    };
  }
  return { ok: false, message: `HTTP ${res.status}`, status: res.status };
}
