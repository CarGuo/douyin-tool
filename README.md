# douyin-tool

> 抖音公开分享内容（视频 / 图集 / 原声）的解析与下载技术学习项目。**仅供个人学习、技术研究，并非任何商业服务。**

<p align="center">
  <img src="packages/web/public/logo-dy.png" width="160" alt="douyin-tool" />
</p>

<p align="center">
  <a href="#项目说明">项目说明</a> ·
  <a href="#使用须知与免责声明">使用须知</a> ·
  <a href="#技术形态">技术形态</a> ·
  <a href="#快速上手">快速上手</a> ·
  <a href="#深入了解">深入了解</a>
</p>

---

## 项目说明

本仓库是一个开源**学习项目**，用来研究 PWA、跨平台前端、Fastify 服务端代理、OSS 抽象、WebView 嵌入式 Android 壳等工程话题。所选样例数据来自抖音公开分享页（`v.douyin.com / www.douyin.com` 用户主动生成的分享链接），不提供任何形式的服务承诺。

---

1. **仅供个人学习、技术研究**。
2. 本项目**不提供**也不**逆向**任何抖音的私有签名、私有接口或受保护的内容；解析逻辑只读取分享页里浏览器即可访问的公开 HTML / URL。
3. **作品版权归原作者所有**。任何下载、保存、再使用都必须取得原作者授权。
4. 抖音平台的策略、风控、链路随时可能变化，本项目可能在任何时候完全失效，**不保证可用性、不保证持续维护**。

---

## 技术形态

本仓库提供两种技术形态用于对照学习：

| 形态                  | 说明                                                          | 系统覆盖                                | 是否需要服务器 |
| ------------------- | ----------------------------------------------------------- | ----------------------------------- | ------- |
| **PWA**（Web）        | Fastify 服务端 + Vite + React 前端，可作为 PWA 装到桌面                  | iOS / Android / Win / macOS / Linux | 需要      |
| **Android APK**     | WebView + 内嵌 NanoHTTPD 本地服务，把同一份 PWA 跑在手机本地，仅供个人本机研究        | 仅 Android 7.0+                      | 不需要外部服务器 |

> **APK 形态说明**：APK 内启动一个仅监听 `127.0.0.1` 的本机 HTTP 服务，WebView 直接连本机；解析与下载完全发生在用户自己的手机内，不涉及任何外部主机。
> APK 启动后会异步检查 GitHub Releases 是否有新版（每 24 小时最多一次，失败静默），有更新则弹窗，点击后跳转浏览器打开 release 页面。

---

## 核心技术点（学习要点）

> 这一节旨在说明**项目作为开源学习样例所覆盖的技术议题**

### 解析

- 从分享文案中用正则抽取 `v.douyin.com` 短链或长链
- HEAD/GET 跟随 301 拿到分享页 URL
- 用仿真移动端 UA + Referer 拉取分享页 HTML
- 在 HTML 中正则定位 `window._ROUTER_DATA = {...}`，遍历 JSON 树取出 `aweme_detail`
- 将公开分享页 URL 中 `playwm` 路径段替换为 `play`（这是分享页本身就携带的两条链接）

### Web / PWA

- Vite + React + Tailwind 单页前端
- 完整 PWA 清单 + service worker 离线壳，支持桌面化（Add to Home Screen）
- iOS Safari 处理：`fetch + Blob + a[download]` 触发"存储到文件"，规避 Safari 接管 mp4 进预览页；监听 `visibilitychange` 重新 `video.load()` 处理后台切回前台 buffer 失效
- 桌面浏览器 File System Access API（`showSaveFilePicker`）

### 服务端

- Fastify 路由 / 钩子 / 流式回写
- 服务端注入 `Referer` 后透传字节系 CDN（浏览器同源策略不允许前端设置 Referer）
- `Range` 透传支持 206 Partial Content
- 主机白名单（`DOWNLOAD_HOST_WHITELIST`）做硬限制，单测覆盖
- 8 位 PIN + HMAC + HttpOnly Cookie + 30 天滑动续期 + 速率限制（个人自托管访问门禁）

### 可选：OSS 中转

- OSS 抽象接口（默认实现：七牛云 Kodo；预留阿里 / 腾讯 / S3）
- 临时对象 30 分钟自动过期，签名 URL 与对象寿命对齐
- 服务端零落盘，全程流式

### Android（APK 形态）

- 单 Activity + WebView + 内嵌 NanoHTTPD
- WebView `setDownloadListener` 拦截 `blob:` URL，注入 JS 通过 `FileReader.readAsDataURL` → JSBridge → MediaStore 落盘
- Adaptive 启动器图标
- GitHub Releases 更新检查（OkHttp，节流 24h，错误静默）

### CI / 工程

- npm workspaces + 项目内自带 Node 20.18（不污染系统）
- Docker 一键部署（`./deploy.sh`）
- GitHub Actions：tag 触发，跑单测 → assembleRelease → 发布 APK 到 GitHub Releases
- APK 使用与 [GSYVideoPlayer](https://github.com/CarGuo/GSYVideoPlayer) 相同的开源公开签名密钥（仅用于 sideload 一致性，**非商业证书**）

---

## 快速上手

> 默认你只是想本地跑起来研究学习。

### 本地开发

```bash
git clone https://github.com/CarGuo/douyin-tool
cd douyin-tool
make setup        # 自动下载项目自带的 Node 20.18，不动你的系统 PATH
make dev          # 后端 :3000 + 前端 :5173
# 浏览器打开 http://localhost:5173
```

不需要预装 nvm / fnm / volta。脚本会下载官方 Node 发行版到项目内 `tools/node/`，所有命令通过 `./bin/npm` 执行。

国内网络下载慢？用清华镜像：
```bash
NODEJS_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/nodejs-release make setup
```

### 自托管部署（仅供个人研究）

```bash
git clone https://github.com/CarGuo/douyin-tool
cd douyin-tool
cp .env.example .env             # 填入 PIN_HASH / AUTH_SECRET
./deploy.sh                      # 默认端口 3000
./deploy.sh 8080                 # 自定义端口
```

完整部署细节、HTTPS、子路径反代、OSS 配置见 [docs/AI_DEPLOY.md](docs/AI_DEPLOY.md)。**自托管不等于公开服务**：请勿对外开放访问、勿提供给非本人使用。

### Android APK（本地形态）

仅支持 Android。可从 [Releases](https://github.com/CarGuo/douyin-tool/releases/latest) 下载已构建的 APK，或自行从源码构建：

```bash
git clone https://github.com/CarGuo/douyin-tool && cd douyin-tool/android
./gradlew :app:assembleDebug    # 输出 app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleRelease  # 用仓库内 release.jks 签名
```

Gradle 在编译前会自动跑 `npm install + npm run -w @douyin-tool/web build`，把最新 PWA 产物同步到 `android/app/src/main/assets/web/`，所以你只需 JDK 17 + Android SDK，无需手工预先构建 web。CI（[.github/workflows/android-release.yml](.github/workflows/android-release.yml)）走同一条链路。

---

## 添加到桌面（PWA）

> **前置条件**：你的部署是 HTTPS 域名（PWA 在 HTTP 下不可装，`localhost` 除外）。

### iPhone / iPad（Safari）

1. **必须用 Safari 打开**（不能是 Chrome / 微信）
2. 点底部 **分享按钮** -> **添加到主屏幕**
3. 主屏幕出现独立图标，点击即以 App 窗口启动

> 微信里点链接打开是 WKWebView，没有"添加到主屏幕"按钮。先点右上角"在 Safari 中打开"。

### Android（Chrome / Edge / Brave / Samsung Internet）

1. Chromium 系浏览器打开站点
2. 右上 **三点菜单** -> **安装应用**
3. 启动器出现独立图标，启动后是独立窗口

### Windows（Edge / Chrome）

地址栏右侧的 **安装** 图标 -> 安装。任务栏 / 开始菜单 / 桌面出现快捷方式。

### macOS

- **macOS 14+ Safari 17+**：菜单栏 **文件 -> 添加到程序坞...**
- **其他**：Chrome / Edge / Arc 地址栏 **安装** 图标

### Linux（Chrome / Chromium / Edge / Brave）

地址栏右侧 **安装** 图标 -> 应用菜单出现独立窗口启动器。

> Firefox 桌面端不能装（Mozilla 移除了桌面 PWA 安装能力），但页面本身可正常访问。

---

## 常见问题

**Q：解析失败 / 502 UPSTREAM 怎么办？**
A：抖音平台风控可能临时拦截，换 IP 或稍后重试；本项目不保证可用性。

**Q：能下载视频以外的内容吗？**
A：分享页公开携带的图集和原声字段都能解析。直播 / 长视频不在范围内。

**Q：为什么 iOS 装上桌面后第一次打开是白屏？**
A：service worker 第一次注册需要打开两次，第二次就秒开了，这是 PWA 通用行为。

**Q：iPhone 点击下载没反应 / 进了 mp4 预览页出不来？**
A：iOS Safari 会无视 `Content-Disposition` 把 mp4 接管为预览页。本项目用 `fetch + Blob + a[download]` 触发系统"存储到文件"对话框；如果还是进了预览页，从屏幕左边缘向右滑动可返回。

**Q：iPhone 后台切回前台后视频"裂开"无法播放？**
A：iOS WKWebView 后台会回收 `<video>` 解码 buffer。代码里监听 `visibilitychange` 自动 `video.load()`。

**Q：能做账号登录 / 历史记录吗？**
A：不持久化任何用户数据是设计前提。如有需要请自行 fork 改造。

**Q：Firefox 桌面装不了，是 bug 吗？**
A：不是。Mozilla 主动移除了桌面 Firefox 的 PWA 安装能力。


---

## 深入了解

| 文档 | 内容 |
|---|---|
| [docs/AI_DEPLOY.md](docs/AI_DEPLOY.md) | AI 协助部署文档（把内容丢给 AI 协助配置） |
| [docs/ENGINEERING.md](docs/ENGINEERING.md) | 工程实现细节：架构、PWA、解析链路、OSS 抽象、API 规格、扩展指南 |
| [harness/ENGINEERING.md](harness/ENGINEERING.md) | 测试策略、fixture 维护、回归报告 |
| [.env.example](.env.example) | 完整环境变量说明 |

---

## 鸣谢

- 字节官方分享页中本就嵌入的 `_ROUTER_DATA` JSON
- Fastify · Vite · React · Tailwind · @fastify/rate-limit · @fastify/cookie 等开源项目

## 声明

本项目仅供**个人学习、技术研究**。请勿用于商业、批量爬取、二次分发或任何违反《抖音用户服务协议》及法律法规的行为。视频 / 图片 / 音频版权归原作者所有；使用本项目产生的全部责任由使用者自行承担。

## License

MIT
