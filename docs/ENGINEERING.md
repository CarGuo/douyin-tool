# 工程实现细节 (douyin-tool)

> 这份文档面向**贡献者 / 想要深入理解实现 / 自行扩展功能**的开发者。
> 终端用户与部署者请看仓库根目录的 [README](../README.md)。
>
> 这里覆盖：架构、PWA 实现细节、解析与下载链路、OSS 中转抽象、安全、API spec、Provider 扩展指南。
> 与本目录平行的 [harness/ENGINEERING.md](../harness/ENGINEERING.md) 是另一个文档：那里记录**测试策略 / fixture 维护 / 历史 bug 复盘**。

---

## 1. 整体架构

```
┌────────── Browser (PWA) ─────────────┐
│  React + Vite + Tailwind             │
│  service-worker (app shell cache)    │
│  PinGate · Result · DownloadDuo      │
└──────────────┬───────────────────────┘
               │  POST /api/auth/login
               │  POST /api/parse
               │  GET  /api/probe   (size hint)
               │  GET  /api/download (stream)
               │  GET  /api/mirror  (OSS status)
               ▼
┌────────── Fastify (Node 20) ─────────┐
│  Auth: HMAC PIN + cookie + rate-lim  │
│  parseService → axios → 抖音 share 页 │
│  /api/download = stream proxy + 白名单│
│  /api/probe    = HEAD/Range 探测      │
│  /api/mirror*  = OSS 抽象层           │
│  Static: /packages/web/dist          │
└──────────────────────────────────────┘
                     │
                     │ (可选)
                     ▼
              ┌────── OSS ───────┐
              │ 七牛 / 阿里 / S3 │
              │ cloud-fetch +    │
              │ 私有签名 URL     │
              └──────────────────┘
```

### 为什么需要后端代理

抖音 CDN 校验 `Referer` 防盗链，浏览器无法跨域设置 Referer。所以：

1. 解析页面：CORS 不允许浏览器直接抓 share 页 HTML。
2. 下载视频：浏览器 `<a download>` 抖音 mp4 直链 → 403。
3. 我们要稳定的文件名 + `Content-Disposition: attachment`。

→ 全部通过后端流式代理解决，详见 [packages/server/src/app.ts](../packages/server/src/app.ts)。

---

## 2. PWA 三件套实现

### 2.1 Web App Manifest

[packages/web/public/manifest.webmanifest](../packages/web/public/manifest.webmanifest)

```json
{
  "name": "抖音解析下载",
  "short_name": "抖音解析",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#000000",
  "theme_color": "#fe2c55",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "icons/icon-maskable-512.png", "sizes": "512x512", "purpose": "maskable" }
  ]
}
```

- `display: standalone` → 启动后无浏览器外壳。
- `maskable` 图标 → Android 自适应蒙版形状。
- `start_url: ./` 与 `scope: ./` → 兼容子路径部署（例如 `/home/dy/`）。

### 2.2 Service Worker

[packages/web/public/sw.js](../packages/web/public/sw.js)：缓存名 `dt-shell-v4`。

- 安装阶段缓存 `index.html` / `manifest.webmanifest` / 主入口 → 离线打开外壳。
- `/api/*` **永不缓存** —— 解析永远走最新接口。
- 导航请求 network-first，离线时回退缓存外壳，避免 iOS 上"白屏 PWA"。
- 升级新版本只需要改 `CACHE` 名（v3 → v4）即可让所有客户端自动 evict 旧 shell。

### 2.3 iOS 元信息 + 多尺寸图标

iOS Safari **不读** manifest.icons，只认 `apple-touch-icon`。
[packages/web/index.html](../packages/web/index.html)：

```html
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="抖音解析" />
<link rel="apple-touch-icon" sizes="152x152" href="./icons/icon-152.png" />
<link rel="apple-touch-icon" sizes="167x167" href="./icons/icon-167.png" />
<link rel="apple-touch-icon" sizes="180x180" href="./icons/icon-180.png" />
```

PNG 图标全档位（iPhone 180 / iPad 152·167 / Android 192·512 / maskable 512）已落仓库 [packages/web/public/icons](../packages/web/public/icons)，由 [packages/web/scripts/gen-icons.mjs](../packages/web/scripts/gen-icons.mjs) 一键生成（macOS 自带 `sips`，**不依赖 ImageMagick**）。

### 2.4 子路径部署

[packages/web/vite.config.ts](../packages/web/vite.config.ts) 读 `DOUYIN_BASE` 环境变量并注入 Vite `base`。SW 通过 `self.registration.scope` 自动推导 base，不需要二次配置。

---

## 3. 解析链路

`POST /api/parse` 流程（[parseService.ts](../packages/server/src/lib/parseService.ts)）：

1. **抽链接**：[extractUrl.ts](../packages/server/src/lib/extractUrl.ts) 从用户粘贴的混合文案里 regex 找出 `v.douyin.com` 短链或 `iesdouyin.com` 长链。
2. **301 跳转**：[douyinClient.resolveShareUrl](../packages/server/src/lib/douyinClient.ts) 用 HEAD（fallback GET）拿 `Location`。
3. **拉 share 页**：用仿真 iPhone Safari 的 UA + Referer。
4. **抽 `_ROUTER_DATA`**：[parser.ts](../packages/server/src/lib/parser.ts) 在 HTML 里 regex 找 `window._ROUTER_DATA = {...}`，walk 树（`findAwemeDetail`）拿到 `aweme_detail`。
5. **URL 变体处理**：分享页 `aweme_detail` 中通常同时携带带 `playwm` 路径段与不带的两条 URL，本项目读取的是分享页本身已公开返回的不带 `playwm` 的那一条；不进行任何签名构造、私有 API 调用或逆向。
6. **可选**：若 `OSS_AUTO_MIRROR=1`，并发触发 [warmupMirror](../packages/server/src/app.ts) 把视频 / 封面 / 图集 / 原声推到 OSS。

---

## 4. 下载与中转

### 4.1 直接下载（origin 流式代理）

`GET /api/download` （[app.ts](../packages/server/src/app.ts)）：

- 主机白名单（`DOWNLOAD_HOST_WHITELIST`）：覆盖整个字节系 CDN（`*.douyinpic.com / *.douyinvod.com / *.byteimg.com / *.bytedance.com / *.amemv.com / *.iesdouyin.com / *.douyincdn.com / *.snssdk.com / *.zjcdn.com / *.bytecdn.cn / *.pstatp.com`），新增必须配套补单测。
- `Referer: https://www.douyin.com/` 由服务端注入（**浏览器不允许跨域设置 Referer**，所以必须经服务端）。
- `Range` 透传 → 支持 `<video>` seek、断点续传、206 Partial Content。
- `inline=1` → 用作 `<video src>`；否则强制 `Content-Disposition: attachment`。

前端流式下载 + 进度条在 [Result.tsx → streamingDownload](../packages/web/src/Result.tsx)：用 `res.body.getReader()` 累计 chunk，得到真实 % / 速度 / 已下载字节。完成后调 `showSaveFilePicker`（File System Access API）弹原生「另存为」；不支持的浏览器 fallback 到 `<a download>` + Blob URL。

### 4.2 OSS 中转下载（可选）

为什么需要：1Mbps VPS 直接下载 30MB 视频 ≈ 4 分钟；OSS 中转后链路是

```
[抖音 CDN] ──云间骨干──> [OSS 桶] ──CDN edge──> [浏览器]
```

origin 完全消失，瓶颈变成你 OSS CDN 的 PoP。

UI（[Result.tsx -> DownloadDuo](../packages/web/src/Result.tsx)）：每条媒体两个按钮 `[ 直接下载 · 12.4 MB ]` `[ OSS 中转下载 ]`。

后端状态机（[mirrorService.ts](../packages/server/src/lib/mirrorService.ts)）：

| 状态        | 说明                                       |
| --------- | ---------------------------------------- |
| idle      | 默认                                       |
| fetching  | provider.cloudFetch 进行中（云端到云端拉取）         |
| ready     | 已落 OSS，签到 URL 可用                         |
| error     | 失败                                       |
| (expired) | TTL 到期 → setTimeout → provider.del + 内存清 |

特性：

- 内存级 LRU 去重 + 同一对象的并发请求 Promise dedup。
- 程序端 `setTimeout(ttlMinutes * 60 * 1000)` 调 `provider.del()` —— 多数 OSS lifecycle 最低粒度 1 天，不满足"30 分钟自动删"。
- 签名 URL TTL 与对象物理寿命对齐（默认 30 分钟）。
- 私有桶 + HMAC 签名 URL + `attname=<filename>` → CDN 回响 `Content-Disposition: attachment`，永不变成新标签视频预览。

### 4.3 大小预探测 (`/api/probe`)

为了在用户**点击之前**就告诉 ta "这视频 12.4 MB"：

- **主路**：HEAD 上游 URL（带抖音 Referer）→ 读 `Content-Length`。
- **兜底**：GET `Range: bytes=0-0` → 解析 `Content-Range: bytes 0-0/<total>`。
- 任何失败一律返回 `{ok:true, size:0}` 让前端优雅降级（按钮不显示大小，但下载本身不受影响）。
- 复用 `DOWNLOAD_HOST_WHITELIST` + `requireAuth` + 90/min rate-limit。

前端 [Result.tsx](../packages/web/src/Result.tsx) 在 `/api/parse` 返回后并发探测视频 / 原声 / 每张图片，结果写入 `sizes` state，DownloadDuo 自动拼到按钮文案。

---

## 5. OSS 提供商抽象层（PicGo 风格）

[packages/server/src/lib/oss/types.ts](../packages/server/src/lib/oss/types.ts)：

```ts
interface OssProvider {
  cloudFetch(opts: { srcUrl: string; objectKey: string; ... }): Promise<CloudFetchResult>;
  head(objectKey: string): Promise<ObjectInfo>;
  signGetUrl(objectKey: string, ttlSec: number, opts?: SignOptions): string;
  del?(objectKey: string): Promise<void>;
}
```

| Provider          | 状态                                           | 文件                                            |
| ----------------- | -------------------------------------------- | --------------------------------------------- |
| 七牛云 Kodo          | 完整实现（fetch / stat / sign / delete，纯 Node `crypto`，无 SDK） | [qiniu.ts](../packages/server/src/lib/oss/qiniu.ts) |
| 阿里云 OSS           | stub                                       | [stubs.ts](../packages/server/src/lib/oss/stubs.ts) |
| 腾讯云 COS           | stub                                       | [stubs.ts](../packages/server/src/lib/oss/stubs.ts) |
| AWS S3 / S3 兼容    | stub                                       | [stubs.ts](../packages/server/src/lib/oss/stubs.ts) |

新增 provider ≈ 80 行：

1. 实现 4 个方法。
2. 在 [oss/index.ts](../packages/server/src/lib/oss/index.ts) `createOssProvider` 的 switch 注册。
3. 加单测（参考 [test/oss/qiniu.test.ts](../packages/server/test/oss/qiniu.test.ts)）。

**为什么不引入官方 SDK**：fetch / stat / sign 三个核心操作都是简单 HTTP + HMAC 签名；引入 SDK 会带来 ~1MB 安装体积 + 传递依赖供应链风险，对一台 1Mbps VPS 不友好。

---

## 6. 鉴权（PIN + HMAC + 滑动续期）

| 层    | 实现                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------- |
| 客户端  | [PinKeypad.tsx](../packages/web/src/components/PinKeypad.tsx) 数字键盘**位置每次随机**（防偷窥肩攻击 + 防触屏热区记忆）        |
| 客户端  | [pinSecurity.ts](../packages/web/src/lib/pinSecurity.ts) 错误指数退避：3 次锁 5s，6 次锁 30s，9 次以上锁 5 分钟         |
| 客户端  | [PinGate.tsx](../packages/web/src/components/PinGate.tsx) 未通过门禁前 React 不渲染功能页，SW 不缓存敏感状态             |
| 服务端  | [auth.ts](../packages/server/src/lib/auth.ts) 用 `HMAC-SHA256(AUTH_SECRET, pin) === PIN_HASH` **常数时间比对** |
| 服务端  | session = HMAC 签名的 `HttpOnly + Secure + SameSite=Lax` cookie                                        |
| 速率限制 | `@fastify/rate-limit`：登录 5 / 解析 30 / 下载 60 / probe 90 / mirror 120 (per minute per IP)              |
| TTL  | `SESSION_TTL_MS=2592000000` (30 天) + 滑动续期：剩余 < 29 天就自动续到完整 30 天                                     |

**PIN 明文从未出现在前端 bundle 里** —— 客户端只把用户键入的 PIN POST 给 `/api/auth/login`，bundle 里没有任何与真实 PIN 相关的字节。

---

## 7. 包年龄检查（供应链防御）

[scripts/check-package-age.mjs](../scripts/check-package-age.mjs) 在 `preinstall` + `postinstall` 自动跑：

- 读 `package-lock.json` 所有 `(name, version)`。
- 通过 `https://registry.npmjs.org/{name}` 查发布时间。
- 任何发布晚于 **当前时间 - 10 天** 的包都让安装失败。

逃生开关：

```bash
AGE_CHECK_DISABLE=1 ./bin/npm install   # 跳过整个检查（不推荐）
AGE_CHECK_OFFLINE=1 ./bin/npm install   # 离线 / 容器构建跳过 registry
MIN_AGE_DAYS=14    ./bin/npm install    # 调整阈值
```

---

## 8. API 完整规格

### `POST /api/auth/login`

```json
// req
{ "pin": "12345678" }
// resp 200
{ "ok": true, "exp": 1745568000000 }
// resp 401
{ "ok": false, "code": "BAD_PIN", "message": "密码不正确" }
```

5/min/IP 限流。session cookie 在 `Set-Cookie` 返回，HttpOnly + Secure。

### `POST /api/auth/logout`

清空 session cookie。

### `GET /api/auth/state`

```json
{ "ok": true, "authenticated": true, "exp": 1745568000000 }
```

### `POST /api/parse`

```json
// req
{ "url": "<分享文本或链接>" }
// resp 200
{
  "ok": true,
  "data": {
    "kind": "video",
    "awemeId": "7637105425053175091",
    "desc": "...",
    "author": { "nickname": "..." },
    "cover": "https://...",
    "video": {
      "playUrl": "https://aweme.snssdk.com/.../playwm/...",
      "playUrlNoWatermark": "https://aweme.snssdk.com/.../play/...",
      "duration": 13896
    },
    "images": [{ "url": "https://..." }],
    "music": { "title": "...", "author": "...", "playUrl": "https://..." }
  },
  "mirror": { "enabled": true, "autoMirror": false, "ttlMinutes": 30, "provider": "qiniu" }
}
```

错误码：`UNAUTHENTICATED` (401) · `INVALID_LINK` (400) · `PARSE_FAILED` (422) · `UPSTREAM` (502) · 速率超限 (429)。

### `GET /api/download?url=<encoded>&filename=<name>&inline=0|1`

流式代理。`url` 必须落在主机白名单内，否则 403。`inline=1` 用作媒体标签的 src。

### `GET /api/probe?url=<encoded>`

```json
{ "ok": true, "size": 13123456 }   // bytes
{ "ok": true, "size": 0 }          // size unknown — frontend hides hint
```

### `GET /api/mirror?awemeId&kind&index?&srcUrl?&filename?`

OSS 状态查询 / 触发。

```json
{ "ok": true, "ready": true, "state": "ready", "url": "https://cdn.../...?token=...", "objectKey": "..." }
```

### `POST /api/mirror/test`

同步阻塞触发并等结果（最长 60s 轮询）。用于操作员一次性确认 OSS 链路健康，**前端"OSS 中转下载"按钮也复用此接口**。

### `GET /api/health`

```json
{ "ok": true, "ts": 1745568000000 }
```

供容器 / 反代健康检查（`docker-compose.yml` 30s 一次）。

---

## 9. 部署模式

### 单容器（推荐）

```bash
cp .env.example .env
# 必填：PIN_HASH AUTH_SECRET
# 选填：OSS_*  DOUYIN_BASE=/home/dy/  HOST_PORT
./deploy.sh                     # = docker compose build && up -d && health
```

[Dockerfile](../Dockerfile) 构建多阶段镜像，[Dockerfile.runtime](../Dockerfile.runtime) 是低内存机器用的"复用本地构建产物"版（配合 [scripts/prepare-deploy-prod.sh](../scripts/prepare-deploy-prod.sh)）。

### 子路径反代（Nginx）

```nginx
location /home/dy/ {
  proxy_pass http://127.0.0.1:3000/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

构建时：`DOUYIN_BASE=/home/dy/ ./bin/npm run build`。

### Caddy（自动 HTTPS）

```caddyfile
dy.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

---

## 10. 测试 / 回归

参考 [harness/ENGINEERING.md](../harness/ENGINEERING.md)。当前用例数：

- 服务端单元 + 集成 = 51（`packages/server/test/*`）。
- 前端组件 = 19（`packages/web/test/*`）。
- 回归脚本 [scripts/run-regression.mjs](../scripts/run-regression.mjs) 聚合上述并写 `harness/regression/last-run.json`。
- 真实链接 smoke `make smoke`（不入 CI、写 `harness/regression/smoke-once-<ts>.json`）。

---

## 11. iOS 特殊处理

**这部分是 iOS WebKit 的非标准行为，必须显式处理：**

### 11.1 mp4 直链被接管为预览页

`<a href="..." download>` 在 iOS Safari 上无视 `Content-Disposition`，会跳转到 mp4 预览页面，用户卡在那里出不来。
解决：[Result.tsx → triggerSave](../packages/web/src/Result.tsx) 用 `fetch + Blob + a[download]`，触发系统"存储到文件"对话框。

### 11.2 Blob URL 释放时机

`URL.revokeObjectURL` 太快会导致慢 iPhone 上 0 字节落地（系统对话框还没读完 blob，URL 已被释放）。我们把释放从 1.5s 改到 60s，blob 由 GC 在写盘后自然回收。

### 11.3 后台回前台 video 裂开

iOS WKWebView 进后台会回收 `<video>` 解码 buffer，回前台 `readyState===0` 渲染成灰色裂开图标。
解决：监听 `visibilitychange` + `pageshow`，回前台若 `readyState===0 || video.error` 自动 `video.load()` 重新拉首段。`poster={cover}` 让裂开瞬间显示封面而非灰图。

### 11.4 文件 App vs 相册两份

iOS 系统行为：选「存储到文件」存一份，再长按视频选「存储视频」相册又存一份。**App / 网页都无法干预**。文档 FAQ 已说明。

---

## 12. 路线图

- 阿里云 OSS / 腾讯云 COS / S3 provider 完整实现。
- Cloudflare Turnstile 选配，给 `/api/parse` 增加防滥用层。
- 浏览器侧 IndexedDB 历史记录（前端独立完成，后端不存数据）。
- Live Photo (HEIC) 抽取。
