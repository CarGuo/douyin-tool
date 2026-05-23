# Engineering Harness

This document is the project's "memory": every architectural decision, test
strategy, regression plan and known limitation lives here. New contributors
should read this in addition to the top-level README.

---

## 1. Architecture at a glance

```
┌────────── Browser (PWA) ─────────────┐
│  React + Vite + Tailwind             │
│  service-worker (app shell cache)    │
└──────────────┬───────────────────────┘
               │  fetch /api/parse
               │  GET   /api/download (stream)
               ▼
┌────────── Fastify (Node 20) ─────────┐
│  POST /api/parse  → parseService     │
│   ├─ extractShareUrl                 │
│   ├─ resolveShareUrl  (302 hop)      │
│   ├─ fetchSharePage   (axios)        │
│   └─ parseHtml        (window._ROUTER_DATA)
│  GET  /api/download → axios stream proxy (host-allow-list)
│  Static: serves /packages/web/dist when SERVE_STATIC=1
└──────────────────────────────────────┘
```

Why a server proxy at all? Because:
1. Douyin CDN enforces `Referer`, browser can't set it cross-origin.
2. CORS forbids direct fetch of share pages.
3. We want stable filenames + Content-Disposition for downloads.

## 2. Decision log

| # | Decision | Rationale |
|---|---------|-----------|
| 1 | Node + Fastify (not Python) | Same language as web; simpler single-process container. |
| 2 | React + Vite + Tailwind | Easy PWA build; small bundle. |
| 3 | Replace `playwm` -> `play` for no-watermark | Long-standing, public technique. No signature reverse engineering required. |
| 4 | Stream-proxy downloads via server | Required for `Referer` and clean filenames. |
| 5 | Host allow-list on `/api/download` | Prevent the proxy from being abused as an open SSRF/relay. |
| 6 | npm packages must be >=10 days old | Defense-in-depth against recent supply-chain attacks (chalk/debug 2025). |
| 7 | Service-worker caches app shell only, never `/api/*` | Avoid serving stale parse results from cache. |

## 3. Testing strategy

| Level | Tool | Lives in | Runs on |
|-------|------|----------|---------|
| Server unit | Vitest | `packages/server/test/*.test.ts` | every commit |
| Server integration | Vitest + `app.inject()` | `packages/server/test/app.test.ts` | every commit |
| Web component | Vitest + Testing Library | `packages/web/test/*.test.tsx` | every commit |
| Regression | `scripts/run-regression.mjs` | aggregates the above + writes report | pre-release |

### Fixtures
HTML fixtures live in `packages/server/test/fixtures/`. They are **handcrafted minimal copies** of the real `_ROUTER_DATA` payloads — never check in real captured pages, they may contain personal data.

### Regression workflow
```bash
npm run test:regression
# -> harness/regression/last-run.json
```
Output JSON shape:
```json
{
  "startedAt": "<ISO ts>",
  "results": [
    { "name": "server-unit", "code": 0, "durationMs": 1234, "ok": true }
  ],
  "summary": { "total": N, "passed": N, "failed": 0 }
}
```
Promote a release **only when `summary.failed === 0`**.

## 4. Adding a new fixture / handling Douyin schema changes

Douyin occasionally tweaks the JSON path (e.g. `aweme_detail` vs `videoInfoRes.item_list`). The parser walks the tree (`findAwemeDetail`) so it tolerates moderate restructuring, but if a real share starts to fail:

1. Capture the broken HTML to a fresh fixture under `packages/server/test/fixtures/<bug-id>.html` (manually scrub any author UID / nickname you don't want committed).
2. Add a test in `parser.test.ts` that loads the fixture and asserts the expected `kind`/fields.
3. Adjust `findAwemeDetail` / `normalizeAweme` until green.
4. Re-run `npm run test:regression`.

## 5. Operational notes

- Container runs as non-root user `node`.
- `HEALTHCHECK` hits `/api/health` every 30 s; tune in `Dockerfile` / `docker-compose.yml`.
- Logs are line-delimited JSON via `pino` (Fastify default). Pipe to `jq` for grepping.
- For HTTPS terminate at Caddy / Nginx; **PWA install on iOS requires HTTPS**.
- Memory footprint at idle: ~80–120 MB.

## 6. Known limitations

- Heavily watermarked or geo-restricted videos may fail at upstream fetch (502 `UPSTREAM`).
- Long videos download streams from Douyin CDN; throughput is bounded by your VPS egress.
- We do **not** persist any user data. No DB, no logs of parsed URLs (Pino logs only request metadata, no bodies).

## 7. Roadmap (deferred)

- Optional Cloudflare Turnstile in front of `/api/parse` to deter abuse.
- Browser-side history (IndexedDB) of recently parsed links.
- Live-photo (heic) extraction.

## 8. Regression report template

`harness/regression/last-run.json` is overwritten on each run. If you want a permanent record, copy the file:
```bash
cp harness/regression/last-run.json harness/regression/$(date +%Y%m%d-%H%M).json
```

## 9. Project-local Node toolchain

The repository is **self-contained** with respect to the JavaScript runtime:

| Component | Path | Role |
|---|---|---|
| Version pin | `.node-version` | Single source of truth (`20.18.0`) |
| Bootstrap | `scripts/bootstrap-node.sh` | Downloads official `node-v$VER-$OS-$ARCH.tar.xz` from `nodejs.org` (or `$NODEJS_MIRROR`), verifies SHA256 against `SHASUMS256.txt`, atomically extracts to `tools/node/` |
| Shims | `bin/node`, `bin/npm` | Always exec the bundled binary; auto-trigger bootstrap if missing |
| Targets | `Makefile` | `setup / dev / test / build / smoke / clean-node` — all routed through `./bin/npm` |

**Why not nvm/n/fnm/volta?** They all require host-level installation and shell rc cooperation, which is brittle across teammates and CI runners. The bootstrap script depends only on `bash + curl + tar + sha256sum/shasum`, which are present on every macOS / Linux box.

**Disk cost:** ~80MB at `tools/node/` plus the ~21MB cached tarball at `tools/.cache/`. Removable via `make clean-node`.

**Docker is unaffected:** the [Dockerfile](../Dockerfile) uses the official `node:20.18.0-alpine` image directly; the local toolchain only serves the host development experience.

## 10. Smoke test policy

Unit / integration tests in `npm test` are **fixture-only** — they never hit `douyin.com`. This keeps CI deterministic and immune to upstream rate limits.

Real-world verification is handled out-of-band by `scripts/oneoff-smoke.mjs` (gitignored), invoked via `make smoke`:

- Boots the Fastify app **in-process** via `app.inject` (no port, no leftover state).
- Posts a real share URL through `/api/parse`.
- Writes a sanitized JSON report to `harness/regression/smoke-once-<ts>.json`.
- Exit codes:
  - `0` — parse succeeded
  - `2` — upstream / risk-control (`PARSE_FAILED`, `UPSTREAM`, `INVALID_LINK`) — **not a code bug**, retry later
  - `1` — code bug (5xx, timeout, exception)

If smoke fails repeatedly with the same code path while the same URL works in a regular browser, that's the signal to follow §4 (schema-drift recipe) — capture a fresh fixture and update the parser.

## 11. Bug log — issues found by full end-to-end regression

This section is the canonical "what went wrong, what we learned" record. Append entries here whenever a regression discovers something the unit tests didn't.

### Bug A — `/api/download` 403 for `aweme.snssdk.com`

**Symptom**
After `/api/parse` succeeded on a real share link, the resolved no-watermark URL pointed at `https://aweme.snssdk.com/...`. Fetching it through `/api/download` returned `HTTP 403 host not allowed`.

**Root cause**
The original `DOWNLOAD_HOST_WHITELIST` in [packages/server/src/app.ts](../packages/server/src/app.ts) only listed the obvious douyin domains (`*.douyinvod.com`, `*.douyinpic.com`, `*.iesdouyin.com`, `*.byteimg.com`, `*.bytedance.com`, `*.amemv.com`, `*.douyincdn.com`). In production Douyin frequently hands out video URLs on the broader ByteDance CDN — `aweme.snssdk.com`, `*.zjcdn.com`, `*.bytecdn.cn`, `*.pstatp.com`. None of these were allowed.

**Why unit tests missed it**
All unit tests used handcrafted fixtures whose `playwm` URL was on `*.douyinvod.com`. They never exercised an `aweme.snssdk.com` URL. The bug only surfaces during a real end-to-end run.

**Fix**
Extended the allow-list to cover the entire ByteDance CDN family, **and** added two regression unit tests so we never regress this:

```ts
/(^|\.)snssdk\.com$/,
/(^|\.)aweme\.snssdk\.com$/,
/\.zjcdn\.com$/,
/\.bytecdn\.cn$/,
/\.pstatp\.com$/,
```

Tests added in [packages/server/test/app.test.ts](../packages/server/test/app.test.ts):
- `allows aweme.snssdk.com (douyin upstream cdn)`
- `allows arbitrary subdomains under snssdk.com`

**Lesson**
Allow-lists must be tested with real production URLs, not just synthesized ones. When extending the list, **always pair the regex change with a test case** that asserts the new host is allowed.

### Bug B — PWA manifest icons 404 in `dist/`

**Symptom**
After `make build`, `curl http://127.0.0.1:3001/icons/icon-192.png` returned `HTTP 500` (or 404 once the route fell through). DevTools -> Application -> Manifest showed every icon in red. Without valid icons, "Add to Home Screen" on iOS would render a generic letter.

**Root cause**
The original plan to generate PNGs at install-time via `gen-icons.mjs` depended on `imagemagick` / `librsvg-bin`, neither of which is installed on a clean macOS box. The script silently degraded to "do nothing" when neither tool was found, so `packages/web/public/icons/` stayed empty and Vite copied **nothing** to `dist/icons/`.

**Fix (final)**
1. Replaced the SVG-based pipeline with a real PNG source: [packages/web/public/logo-dy.png](../packages/web/public/logo-dy.png).
2. Rewrote [packages/web/scripts/gen-icons.mjs](../packages/web/scripts/gen-icons.mjs) to use macOS-native `sips` (no install required); `magick` is a fallback for Linux contributors.
3. Generated PNGs **and committed them to the repo**: `icon-152 / 167 / 180 / 192 / 512 / maskable-512`. So a clean clone never needs ImageMagick.
4. [manifest.webmanifest](../packages/web/public/manifest.webmanifest) and [index.html](../packages/web/index.html) reference the PNGs directly (no SVG fallback).

**Lesson**
Anything that's needed for the artifact to function (icons, fonts, generated CSS) must either be **committed** or generated by something the OS itself ships. Never rely on an optional dev dependency that "should be installed."

### Bug C — App shell didn't show the brand

**Symptom**
Even after the manifest icons were valid, the React `App.tsx` header was just text. The tab favicon worked but the app's own header looked unbranded.

**Fix**
Added an `<img src="/icons/icon-192.png">` above the `<h1>` in [packages/web/src/App.tsx](../packages/web/src/App.tsx) so the brand is visible in-app, on standalone PWA, and on the share-card screenshot.

**Lesson**
"Logo work" isn't done at the manifest layer alone — also wire it into the in-app header so the standalone PWA looks intentional, not generic.
