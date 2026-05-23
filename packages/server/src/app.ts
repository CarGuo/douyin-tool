import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  createParseService,
  InvalidLinkError,
  ParseFailedError,
  UpstreamError,
  type ParseServiceDeps,
} from './lib/parseService.js';
import { createDouyinClient } from './lib/douyinClient.js';
import { isAllowedHost } from './lib/extractUrl.js';
import {
  AuthConfig,
  SESSION_COOKIE,
  SLIDING_RENEW_THRESHOLD_MS,
  loadAuthConfig,
  signSession,
  verifyPinAgainstHash,
  verifySession,
} from './lib/auth.js';
import { createOssProvider, loadOssEnv, type OssEnv } from './lib/oss/index.js';
import { MirrorService, type MirrorKind } from './lib/mirrorService.js';
import type { ParsedAweme } from './lib/parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppOptions {
  parseDeps?: ParseServiceDeps;
  serveStatic?: boolean;
  logger?: boolean;
  auth?: AuthConfig | false;
  rateLimit?: boolean;
}

const DOWNLOAD_HOST_WHITELIST = [
  /\.douyinpic\.com$/,
  /\.douyinvod\.com$/,
  /\.bytedance\.com$/,
  /\.byteimg\.com$/,
  /\.amemv\.com$/,
  /\.iesdouyin\.com$/,
  /\.douyincdn\.com$/,
  /(^|\.)snssdk\.com$/,
  /(^|\.)aweme\.snssdk\.com$/,
  /\.zjcdn\.com$/,
  /\.bytecdn\.cn$/,
  /\.pstatp\.com$/,
];

function isDownloadHostAllowed(host: string): boolean {
  if (isAllowedHost(host)) return true;
  return DOWNLOAD_HOST_WHITELIST.some((re) => re.test(host));
}

function resolveAuthConfig(opts: AppOptions): AuthConfig | null {
  if (opts.auth === false) return null;
  if (opts.auth) return opts.auth;
  try {
    return loadAuthConfig();
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      throw err;
    }
    return null;
  }
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true, bodyLimit: 1024 * 64 });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(fastifyCookie);

  const auth = resolveAuthConfig(opts);
  const rateLimitOn = opts.rateLimit ?? auth !== null;

  if (rateLimitOn) {
    await app.register(fastifyRateLimit, {
      global: false,
      addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'retry-after': true },
    });
  }

  const service = createParseService(opts.parseDeps);
  const downloadClient = createDouyinClient();

  // Optional OSS mirror layer. When enabled, /api/parse fans out cloud-fetch
  // jobs in the background; the front-end then prefers the OSS signed URL
  // over our 1Mbps origin proxy. When disabled (no env), everything keeps
  // working through /api/download as before.
  const ossEnv: OssEnv = loadOssEnv();
  const ossProvider = createOssProvider(ossEnv);
  const mirror = ossProvider
    ? new MirrorService({
        provider: ossProvider,
        signedUrlTtlSec: ossEnv.ttlMinutes * 60,
        logger: app.log,
      })
    : null;
  if (mirror) {
    app.log.info(
      {
        provider: ossEnv.provider,
        bucket: ossEnv.bucket,
        ttlMinutes: ossEnv.ttlMinutes,
        autoMirror: ossEnv.autoMirror,
      },
      ossEnv.autoMirror
        ? 'OSS mirror enabled (auto-warmup ON)'
        : 'OSS mirror configured (auto-warmup OFF — manual /api/mirror/test only)',
    );
  } else {
    app.log.info('OSS mirror disabled (no OSS_PROVIDER configured)');
  }

  function warmupMirror(data: ParsedAweme): void {
    if (!mirror || !data.awemeId) return;
    const fire = (kind: MirrorKind, srcUrl: string | undefined, index?: number) => {
      if (!srcUrl) return;
      mirror
        .ensureMirror({ awemeId: data.awemeId, kind, index, srcUrl })
        .catch((err) => app.log.warn({ err, kind, index }, 'mirror warmup failed'));
    };
    fire('cover', data.cover);
    if (data.kind === 'video') {
      const v = data.video?.playUrlNoWatermark || data.video?.playUrl;
      fire('video', v);
    } else if (data.kind === 'image' && Array.isArray(data.images)) {
      data.images.forEach((img, i) => fire('image', img.url, i));
    }
    fire('music', data.music?.playUrl);
  }


  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

  function requireAuth(req: FastifyRequest, reply: FastifyReply, done: () => void) {
    if (!auth) return done();
    const tk = req.cookies?.[SESSION_COOKIE];
    const payload = verifySession(tk, auth.hmacSecret);
    if (!payload) {
      reply.code(401).send({ ok: false, code: 'UNAUTHENTICATED', message: '未登录或会话已过期' });
      return;
    }
    const remaining = payload.exp - Date.now();
    if (remaining > 0 && remaining < auth.sessionTtlMs - SLIDING_RENEW_THRESHOLD_MS) {
      const fresh = signSession(auth.hmacSecret, auth.sessionTtlMs);
      reply.setCookie(SESSION_COOKIE, fresh, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: Math.floor(auth.sessionTtlMs / 1000),
      });
    }
    done();
  }

  if (auth) {
    app.post<{ Body: { pin?: string } }>(
      '/api/auth/login',
      {
        config: rateLimitOn
          ? {
              rateLimit: {
                max: 5,
                timeWindow: '1 minute',
                keyGenerator: (req) =>
                  (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
              },
            }
          : undefined,
        schema: {
          body: {
            type: 'object',
            required: ['pin'],
            properties: { pin: { type: 'string', minLength: 1, maxLength: 64 } },
          },
        },
      },
      async (req, reply) => {
        const pin = req.body?.pin ?? '';
        const ok = verifyPinAgainstHash(pin, auth.pinHashHex, auth.hmacSecret);
        if (!ok) {
          return reply.code(401).send({ ok: false, code: 'BAD_PIN', message: '密码不正确' });
        }
        const token = signSession(auth.hmacSecret, auth.sessionTtlMs);
        const exp = Date.now() + auth.sessionTtlMs;
        reply.setCookie(SESSION_COOKIE, token, {
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          path: '/',
          maxAge: Math.floor(auth.sessionTtlMs / 1000),
        });
        return { ok: true, exp };
      },
    );

    app.post('/api/auth/logout', async (_req, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.get('/api/auth/state', async (req) => {
      const tk = req.cookies?.[SESSION_COOKIE];
      const payload = verifySession(tk, auth.hmacSecret);
      return { ok: true, authenticated: !!payload, exp: payload?.exp ?? 0 };
    });
  }

  app.post<{ Body: { url?: string } }>(
    '/api/parse',
    {
      preHandler: requireAuth,
      config: rateLimitOn
        ? {
            rateLimit: {
              max: 30,
              timeWindow: '1 minute',
              keyGenerator: (req) =>
                (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
            },
          }
        : undefined,
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } },
        },
      },
    },
    async (req, reply) => {
      const text = req.body?.url ?? '';
      try {
        const data = await service.parseFromUserInput(text);
        // Mirror warmup is OPT-IN. By default, even when OSS credentials are
        // configured we do NOT automatically push to the storage on every
        // parse — too risky before the operator has verified the cloud-fetch
        // path actually works (provider-side referer rejection, region
        // mismatches, etc). Operators can flip OSS_AUTO_MIRROR=1 once the
        // manual /api/mirror/test endpoint confirms the pipe is healthy.
        if (mirror && ossEnv.autoMirror) {
          warmupMirror(data);
        }
        return {
          ok: true,
          data,
          mirror: mirror
            ? {
                enabled: true,
                autoMirror: ossEnv.autoMirror,
                ttlMinutes: ossEnv.ttlMinutes,
                provider: ossEnv.provider,
              }
            : { enabled: false, autoMirror: false },
        };
      } catch (err) {
        if (err instanceof InvalidLinkError) {
          return reply.code(400).send({ ok: false, code: err.code, message: err.message });
        }
        if (err instanceof ParseFailedError) {
          return reply.code(422).send({ ok: false, code: err.code, message: err.message });
        }
        if (err instanceof UpstreamError) {
          return reply.code(502).send({ ok: false, code: err.code, message: err.message });
        }
        req.log.error(err);
        return reply.code(500).send({ ok: false, code: 'INTERNAL', message: '服务器内部错误' });
      }
    },
  );

  // Query/wait endpoint for mirrored objects. Front-end polls this with
  // (awemeId, kind, index?) and either gets `{ ready:false }` or
  // `{ ready:true, url }` where `url` is a signed OSS GET URL good for
  // OSS_OBJECT_TTL_MINUTES minutes. When OSS is disabled this just returns 404
  // so the client falls back to /api/download.
  app.get<{
    Querystring: {
      awemeId?: string;
      kind?: string;
      index?: string;
      filename?: string;
      srcUrl?: string;
    };
  }>(
    '/api/mirror',
    {
      preHandler: requireAuth,
      config: rateLimitOn
        ? {
            rateLimit: {
              max: 120,
              timeWindow: '1 minute',
              keyGenerator: (req) =>
                (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
            },
          }
        : undefined,
    },
    async (req, reply) => {
      if (!mirror) {
        return reply.code(404).send({ ok: false, code: 'OSS_DISABLED', message: 'mirror not configured' });
      }
      const { awemeId, kind, index, filename, srcUrl } = req.query;
      if (!awemeId || !kind) {
        return reply.code(400).send({ ok: false, message: 'awemeId and kind required' });
      }
      const validKinds: MirrorKind[] = ['video', 'cover', 'image', 'music'];
      if (!validKinds.includes(kind as MirrorKind)) {
        return reply.code(400).send({ ok: false, message: `kind must be one of ${validKinds.join('|')}` });
      }
      const idx = index !== undefined ? Number(index) : undefined;
      // If srcUrl is given and the entry is still idle, kick off a fresh fetch
      // (covers the case where /api/parse warmup didn't run, e.g. restart).
      if (srcUrl) {
        try {
          new URL(srcUrl);
          await mirror.ensureMirror({
            awemeId,
            kind: kind as MirrorKind,
            index: Number.isFinite(idx) ? (idx as number) : undefined,
            srcUrl,
          });
        } catch (err) {
          req.log.warn({ err }, 'mirror lazy ensure failed');
        }
      }
      const status = await mirror.getMirrorStatus(
        {
          awemeId,
          kind: kind as MirrorKind,
          index: Number.isFinite(idx) ? (idx as number) : undefined,
        },
        filename ? { attachmentFilename: filename } : undefined,
      );
      return {
        ok: true,
        ready: status.state === 'ready',
        state: status.state,
        url: status.signedUrl,
        objectKey: status.objectKey,
        startedAt: status.startedAt,
        finishedAt: status.finishedAt,
        error: status.error,
      };
    },
  );

  // Manual end-to-end test for the OSS pipe. Posts {srcUrl, kind, [awemeId]}
  // and BLOCKS until the cloud-fetch finishes (or fails), then returns the
  // signed URL plus head() metadata. Used by the admin "Test mirror" button
  // in the UI so operators can verify a single round-trip before enabling
  // OSS_AUTO_MIRROR globally.
  //
  // We deliberately keep this synchronous (no long-poll dance) — the user
  // is staring at a button and wants a clear pass/fail.
  app.post<{
    Body: {
      srcUrl?: string;
      kind?: string;
      awemeId?: string;
      index?: number;
      filename?: string;
    };
  }>(
    '/api/mirror/test',
    {
      preHandler: requireAuth,
      config: rateLimitOn
        ? {
            rateLimit: {
              max: 10,
              timeWindow: '1 minute',
              keyGenerator: (req) =>
                (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
            },
          }
        : undefined,
      schema: {
        body: {
          type: 'object',
          required: ['srcUrl', 'kind'],
          properties: {
            srcUrl: { type: 'string', minLength: 1, maxLength: 4096 },
            kind: { type: 'string', enum: ['video', 'cover', 'image', 'music'] },
            awemeId: { type: 'string', maxLength: 64 },
            index: { type: 'integer', minimum: 0, maximum: 50 },
            filename: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!mirror) {
        return reply.code(404).send({ ok: false, code: 'OSS_DISABLED', message: 'mirror not configured' });
      }
      const { srcUrl, kind, awemeId, index, filename } = req.body;
      try {
        new URL(srcUrl!);
      } catch {
        return reply.code(400).send({ ok: false, message: 'invalid srcUrl' });
      }
      // For one-off tests we synthesise a stable id from the url hash so
      // repeated tests of the same url don't pollute the bucket with dupes.
      const testAwemeId =
        awemeId && awemeId.length > 0
          ? awemeId
          : `test-${Buffer.from(srcUrl!).toString('hex').slice(0, 16)}`;
      const startedAt = Date.now();
      try {
        await mirror.ensureMirror({
          awemeId: testAwemeId,
          kind: kind as MirrorKind,
          index,
          srcUrl: srcUrl!,
        });
        // Poll status (up to 60s) — most providers we care about are sync,
        // but ensureMirror returns immediately on first call; we wait for
        // the inflight Promise via getMirrorStatus loop.
        let status = await mirror.getMirrorStatus(
          { awemeId: testAwemeId, kind: kind as MirrorKind, index },
          filename ? { attachmentFilename: filename } : undefined,
        );
        const deadline = Date.now() + 60_000;
        while (status.state === 'fetching' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          status = await mirror.getMirrorStatus(
            { awemeId: testAwemeId, kind: kind as MirrorKind, index },
            filename ? { attachmentFilename: filename } : undefined,
          );
        }
        const elapsedMs = Date.now() - startedAt;
        if (status.state !== 'ready') {
          return reply.code(502).send({
            ok: false,
            code: 'MIRROR_FAILED',
            message: status.error || `mirror state=${status.state} after ${elapsedMs}ms`,
            objectKey: status.objectKey,
            elapsedMs,
          });
        }
        return {
          ok: true,
          objectKey: status.objectKey,
          url: status.signedUrl,
          elapsedMs,
          provider: ossEnv.provider,
          ttlMinutes: ossEnv.ttlMinutes,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        req.log.warn({ err, srcUrl }, '/api/mirror/test failed');
        return reply.code(502).send({
          ok: false,
          code: 'MIRROR_ERROR',
          message,
          elapsedMs: Date.now() - startedAt,
        });
      }
    },
  );

  // Pre-download size hint. The frontend calls this once per media URL after
  // /api/parse returns so the "直接下载" buttons can show a "12.4 MB" hint
  // BEFORE the user clicks. Strategy:
  //   1) HEAD the upstream URL with the Douyin Referer set — most CDNs honor
  //      this and return Content-Length.
  //   2) If HEAD doesn't return a parseable length (some CDNs respond 405 or
  //      strip the header), fall back to GET with `Range: bytes=0-0`. The
  //      response is `Content-Range: bytes 0-0/<total>` from which we extract
  //      <total>. The 1-byte body is discarded — we only ever read headers.
  // Either way we never proxy any payload, so this is cheap.
  app.get<{ Querystring: { url?: string } }>(
    '/api/probe',
    {
      preHandler: requireAuth,
      config: rateLimitOn
        ? {
            rateLimit: {
              max: 90,
              timeWindow: '1 minute',
              keyGenerator: (req) =>
                (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
            },
          }
        : undefined,
    },
    async (req, reply) => {
      const target = req.query.url;
      if (!target) return reply.code(400).send({ ok: false, message: 'missing url' });
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return reply.code(400).send({ ok: false, message: 'invalid url' });
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return reply.code(400).send({ ok: false, message: 'unsupported protocol' });
      }
      if (!isDownloadHostAllowed(parsed.hostname)) {
        return reply
          .code(403)
          .send({ ok: false, message: `host not allowed: ${parsed.hostname}` });
      }

      const upstreamHeaders: Record<string, string> = {
        Referer: 'https://www.douyin.com/',
      };

      // HEAD first.
      try {
        const head = await downloadClient.head(target, {
          headers: upstreamHeaders,
          validateStatus: (s) => s >= 200 && s < 400,
        });
        const cl = head.headers['content-length'];
        const n = typeof cl === 'string' ? Number(cl) : 0;
        if (Number.isFinite(n) && n > 0) {
          return { ok: true, size: n };
        }
      } catch {
        // some CDNs reject HEAD with 405 — fall through to Range.
      }

      // Range fallback — read 1 byte and parse Content-Range total.
      try {
        const ranged = await downloadClient.get(target, {
          headers: { ...upstreamHeaders, Range: 'bytes=0-0' },
          // We must NOT stream the body here — we only need headers — but we
          // also can't HEAD again. Use a small buffer-mode GET.
          responseType: 'arraybuffer',
          validateStatus: (s) => s >= 200 && s < 400,
        });
        const cr = ranged.headers['content-range'];
        if (typeof cr === 'string') {
          const m = /\/(\d+)$/.exec(cr);
          if (m) {
            const total = Number(m[1]);
            if (Number.isFinite(total) && total > 0) {
              return { ok: true, size: total };
            }
          }
        }
        const cl = ranged.headers['content-length'];
        const n = typeof cl === 'string' ? Number(cl) : 0;
        if (Number.isFinite(n) && n > 0) {
          return { ok: true, size: n };
        }
      } catch (err) {
        req.log.warn({ err, host: parsed.hostname }, 'probe range fallback failed');
      }

      return { ok: true, size: 0 };
    },
  );

  app.get<{ Querystring: { url?: string; filename?: string; inline?: string } }>(
    '/api/download',
    {
      preHandler: requireAuth,
      config: rateLimitOn
        ? {
            rateLimit: {
              max: 60,
              timeWindow: '1 minute',
              keyGenerator: (req) =>
                (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
            },
          }
        : undefined,
    },
    async (req, reply) => {
      const target = req.query.url;
      if (!target) return reply.code(400).send({ ok: false, message: 'missing url' });
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return reply.code(400).send({ ok: false, message: 'invalid url' });
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return reply.code(400).send({ ok: false, message: 'unsupported protocol' });
      }
      if (!isDownloadHostAllowed(parsed.hostname)) {
        return reply
          .code(403)
          .send({ ok: false, message: `host not allowed: ${parsed.hostname}` });
      }

      const inline = req.query.inline === '1';
      const upstreamHeaders: Record<string, string> = {
        Referer: 'https://www.douyin.com/',
      };
      // Pass through Range so <video> seek / byte-range works for inline playback.
      const rangeHeader = req.headers['range'];
      if (typeof rangeHeader === 'string' && rangeHeader.length > 0) {
        upstreamHeaders.Range = rangeHeader;
      }

      try {
        const upstream = await downloadClient.get(target, {
          responseType: 'stream',
          headers: upstreamHeaders,
          // Allow 206 Partial Content to flow through.
          validateStatus: (s) => s >= 200 && s < 400,
        });
        const ct = upstream.headers['content-type'] ?? 'application/octet-stream';
        const cl = upstream.headers['content-length'];
        const cr = upstream.headers['content-range'];
        const ar = upstream.headers['accept-ranges'];
        reply.header('content-type', ct);
        if (cl) reply.header('content-length', cl);
        if (cr) reply.header('content-range', cr);
        reply.header('accept-ranges', ar || 'bytes');
        if (upstream.status === 206) reply.code(206);
        if (inline) {
          reply.header('content-disposition', 'inline');
          // Allow long-ish browser caching for cover/video so playback is smooth.
          reply.header('cache-control', 'private, max-age=300');
        } else {
          const safeName = (req.query.filename ?? 'douyin-download').replace(/[^\w.\-]+/g, '_');
          reply.header('content-disposition', `attachment; filename="${safeName}"`);
        }
        return reply.send(upstream.data);
      } catch (err) {
        req.log.error({ err }, 'download proxy error');
        return reply.code(502).send({ ok: false, message: '下载失败' });
      }
    },
  );

  if (opts.serveStatic ?? process.env.SERVE_STATIC === '1') {
    const candidates = [
      resolve(__dirname, '../../web/dist'),
      resolve(__dirname, '../../../packages/web/dist'),
      resolve(process.cwd(), 'packages/web/dist'),
    ];
    const root = candidates.find((p) => existsSync(p));
    if (root) {
      await app.register(fastifyStatic, { root, prefix: '/', decorateReply: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api')) {
          return reply.code(404).send({ ok: false, message: 'not found' });
        }
        return reply.sendFile('index.html');
      });
      app.log.info({ root }, 'serving static frontend');
    } else {
      app.log.warn('SERVE_STATIC requested but no web/dist found, skipping');
    }
  }

  return app;
}
