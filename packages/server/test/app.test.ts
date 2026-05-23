import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const here = dirname(fileURLToPath(import.meta.url));
const VIDEO_HTML = readFileSync(resolve(here, 'fixtures/video.html'), 'utf8');
const IMAGE_HTML = readFileSync(resolve(here, 'fixtures/image.html'), 'utf8');

function makeApp(html: string): Promise<FastifyInstance> {
  return buildApp({
    logger: false,
    parseDeps: {
      resolveUrl: async (u) => u.replace('v.douyin.com', 'www.iesdouyin.com'),
      fetchPage: async () => html,
    },
  });
}

describe('POST /api/parse', () => {
  it('returns 400 when no douyin link in input', async () => {
    const app = await makeApp(VIDEO_HTML);
    const res = await app.inject({
      method: 'POST',
      url: '/api/parse',
      payload: { url: 'no link here' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('INVALID_LINK');
    await app.close();
  });

  it('parses a video share', async () => {
    const app = await makeApp(VIDEO_HTML);
    const res = await app.inject({
      method: 'POST',
      url: '/api/parse',
      payload: { url: '看看 https://v.douyin.com/iABCDEF/' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.kind).toBe('video');
    expect(body.data.video.playUrlNoWatermark).toContain('/play/');
    await app.close();
  });

  it('parses an image collection share', async () => {
    const app = await makeApp(IMAGE_HTML);
    const res = await app.inject({
      method: 'POST',
      url: '/api/parse',
      payload: { url: 'https://www.iesdouyin.com/share/note/7300000000000000002/' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.kind).toBe('image');
    expect(body.data.images.length).toBe(3);
    await app.close();
  });

  it('returns 422 when html cannot be parsed', async () => {
    const app = await makeApp('<html>broken</html>');
    const res = await app.inject({
      method: 'POST',
      url: '/api/parse',
      payload: { url: 'https://v.douyin.com/iZZZZZZ/' },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

describe('GET /api/download', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp(VIDEO_HTML);
  });

  it('rejects missing url', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/download' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects disallowed host', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/download?url=https://evil.example.com/x.mp4',
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects bad protocol', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/download?url=ftp://aweme.snssdk.com/x.mp4',
    });
    expect(res.statusCode).toBe(400);
  });

  it('allows aweme.snssdk.com (douyin upstream cdn)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/download?url=' +
        encodeURIComponent('https://aweme.snssdk.com/aweme/v1/play/?video_id=does_not_exist'),
    });
    expect(res.statusCode).not.toBe(403);
  });

  it('allows arbitrary subdomains under snssdk.com', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/download?url=' +
        encodeURIComponent('https://api3-normal.snssdk.com/foo'),
    });
    expect(res.statusCode).not.toBe(403);
  });
});

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const app = await makeApp(VIDEO_HTML);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });
});

describe('GET /api/probe', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp(VIDEO_HTML);
  });

  it('rejects missing url', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/probe' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid url', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/probe?url=' + encodeURIComponent('not-a-url'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects disallowed host', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/probe?url=' + encodeURIComponent('https://evil.example.com/x.mp4'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows whitelisted host (returns 200 even when upstream HEAD fails)', async () => {
    // The upstream is unreachable in tests, but the endpoint is designed to
    // degrade gracefully and respond `{ok:true, size:0}` rather than 5xx,
    // so the frontend can still render the button without a size hint.
    const res = await app.inject({
      method: 'GET',
      url: '/api/probe?url=' +
        encodeURIComponent('https://aweme.snssdk.com/aweme/v1/play/?video_id=does_not_exist'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.size).toBe('number');
  });
});
