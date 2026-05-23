# AI 部署一条龙

> **怎么用**：把这份文档**整个**复制粘贴给 ChatGPT / Claude / Gemini / 通义千问 / DeepSeek
> 等任意大模型，告诉它："请按照这份文档帮我把 douyin-tool 部署到我的服务器上"，
> 然后把你的服务器信息（IP、SSH 用户、域名等）告诉它。AI 会基于这份文档全程牵着
> 你的手把服务部署起来。
>
> **目标读者**：完全没碰过 Linux / Docker / Nginx 的小白也能跟着做。

---

## 给 AI 的指令模板

复制下面整块给 AI：

```
我要把开源项目 douyin-tool（https://github.com/CarGuo/douyin-tool）
部署到我的服务器，请你按照下面的"AI 部署一条龙"文档一步步带我做。

我的环境：
- 服务器系统：__（例如 Ubuntu 22.04 / Debian 12 / CentOS 7 / 阿里云 / 腾讯云轻量 / DigitalOcean）
- 服务器 IP：__
- 我已绑定的域名：__（例如 dy.example.com，没有就写"暂无"）
- SSH 登录方式：__（密码 / 密钥）
- 我希望访问的入口端口：__（默认 3000）
- 是否需要 OSS 中转：__（是 / 否）

请：
1. 先给我一段一段可复制的命令；
2. 每一步告诉我"你应该看到什么输出"，让我能判断是否成功；
3. 如果某一步失败，给我对应的排错命令。
```

---

## 一、部署前准备

### 1.1 你需要什么

| 项 | 最低要求 | 推荐 |
|---|---|---|
| 服务器 | 1 核 CPU、1GB 内存、10GB 磁盘 | 1C2G / 25GB SSD |
| 系统 | Ubuntu 20.04+、Debian 10+、CentOS 7+ 都行 | Ubuntu 22.04 LTS |
| 软件 | Docker 20.10+ + Docker Compose v2 | 见下文一键安装命令 |
| 域名（可选） | 不强制，但 iOS PWA 需要 HTTPS 才能装到桌面 | 任意域名解析到服务器 IP |
| 网络 | 服务器能访问 github.com、抖音 CDN | 国内服务器需保证能拉镜像 |

### 1.2 安装 Docker（一行命令）

**Ubuntu / Debian**：
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo usermod -aG docker $USER     # 之后重新登录 SSH，docker 命令就不需要 sudo 了
```

**CentOS / RHEL**：
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

**国内网络拉不下来**：用阿里云镜像
```bash
curl -fsSL https://get.docker.com | sudo sh -s -- --mirror Aliyun
```

**验证**：
```bash
docker --version              # 期望：Docker version 24.x.x 或更高
docker compose version        # 期望：Docker Compose version v2.x.x
```

如果你要让 AI 处理"我服务器还没装 Docker"的情况，把上面这段直接发给 AI 就行。

---

## 二、拉代码 + 配置

### 2.1 克隆仓库

```bash
cd ~
git clone https://github.com/CarGuo/douyin-tool.git
cd douyin-tool
```

### 2.2 生成访问密码（PIN）

PIN 是别人访问你部署的站点时需要输入的 8 位密码。**不能直接写明文**，要先做 HMAC-SHA256 哈希：

```bash
# 在你本机或服务器上随便哪台机器，用 node 或 python 都行
docker run --rm node:20-alpine node -e '
  const crypto = require("crypto");
  const pin    = "12345678";                                   // 改成你想要的 8 位数字
  const secret = crypto.randomBytes(32).toString("hex");      // 自动生成 32 字节随机串
  console.log("PIN_HASH    =", crypto.createHmac("sha256", secret).update(pin).digest("hex"));
  console.log("AUTH_SECRET =", secret);
'
```

**输出示例**：
```
PIN_HASH    = 7a3b...（64 位 hex）
AUTH_SECRET = 9f2e...（64 位 hex）
```

### 2.3 写 .env

```bash
cp .env.example .env
nano .env       # 或 vim .env
```

把刚才输出的两行填进去：

```dotenv
DOUYIN_BASE=/
HOST_PORT=3000
AUTH_SECRET=9f2e...（你刚才生成的）
PIN_HASH=7a3b...（你刚才生成的）
SESSION_TTL_MS=2592000000

# 下面 OSS 部分留空就是不启用中转，普通用户不用管
OSS_PROVIDER=
OSS_ACCESS_KEY=
OSS_SECRET_KEY=
OSS_BUCKET=
OSS_REGION=
OSS_PUBLIC_HOST=
OSS_OBJECT_TTL_MINUTES=30
OSS_AUTO_MIRROR=0
```

> **重要**：`.env` 已经在 `.gitignore` 里，不会被提交。**永远不要把 .env 上传到 GitHub**。

---

## 三、一键部署

```bash
./deploy.sh                # 默认监听 3000 端口
# 或者
./deploy.sh 8080           # 改端口
```

脚本会自动：
1. 用 Docker 构建镜像（首次需要 3-5 分钟）
2. 启动容器（监听 `127.0.0.1:3000`，**只对本机可见**）
3. 等 2 秒后调 `/api/health` 健康检查

**期望输出**：
```
==> Building image (this may take a few minutes)...
==> Starting service on port 3000...
==> Health check:
{"ok":true,"ts":1780000000000}
==> OK. Open http://<your-server-ip>:3000/ in a browser.
```

### 排错

| 现象 | 解决 |
|---|---|
| `Docker not found` | 回到 §1.2 装 Docker |
| `docker compose build` 卡住 | 检查网络；国内服务器换镜像源（见下文 §六） |
| 健康检查失败 | `docker compose logs -f douyin-tool` 看具体报错 |
| `PIN_HASH` 缺失退出 | `.env` 没填好；重新执行 §2.2 |

---

## 四、加 HTTPS 域名（推荐）

> **为什么必需**：iOS Safari 必须 HTTPS 才能"添加到主屏幕"。HTTP 只能在浏览器里用。

### 4.1 域名解析

去你的域名服务商（阿里云、Cloudflare、Namesilo 等）添加一条 A 记录：

```
类型: A
主机: dy             (子域名，可以叫别的)
值:   你的服务器公网 IP
TTL:  600
```

等待生效（一般 1-5 分钟），用 `ping dy.example.com` 验证 IP 是不是你的服务器。

### 4.2 用 Caddy 自动签 HTTPS（最省心）

Caddy 会自动从 Let's Encrypt 申请证书并自动续期。

```bash
# 装 Caddy（Ubuntu / Debian）
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy

# 写配置
sudo tee /etc/caddy/Caddyfile <<'EOF'
dy.example.com {
  reverse_proxy 127.0.0.1:3000
}
EOF

# 重启
sudo systemctl restart caddy
sudo systemctl status caddy
```

**验证**：浏览器打开 `https://dy.example.com/`，看到登录界面就成功了。

### 4.3 用 Nginx 自己装证书

如果你已经有 Nginx：

```nginx
server {
  listen 443 ssl http2;
  server_name dy.example.com;
  ssl_certificate     /etc/letsencrypt/live/dy.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dy.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
server {
  listen 80;
  server_name dy.example.com;
  return 301 https://$server_name$request_uri;
}
```

证书用 `certbot --nginx -d dy.example.com` 自动申请。

---

## 五、把图标加到桌面

部署成功后，每台设备上：

| 设备 | 操作 |
|---|---|
| iPhone / iPad | **Safari** 打开 -> 分享按钮 -> 添加到主屏幕 |
| Android | Chrome / Edge 打开 -> 三点菜单 -> 安装应用 |
| Windows | Edge / Chrome 地址栏右侧"安装"图标 |
| macOS | Safari 17+：文件菜单 -> 添加到程序坞；或 Chrome / Edge 地址栏"安装" |
| Linux | Chrome 系地址栏"安装" |

启动后是独立窗口、独立图标，跟原生 App 几乎无差。

---

## 六、国内服务器加速（可选）

### 6.1 Docker 镜像源加速

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.com"
  ]
}
EOF
sudo systemctl restart docker
```

### 6.2 npm 镜像

构建 Docker 镜像时如果觉得慢，可以临时改 [Dockerfile](../Dockerfile) 在 `npm ci` 之前加：

```dockerfile
RUN npm config set registry https://registry.npmmirror.com
```

---

## 七、升级到新版本

```bash
cd ~/douyin-tool
git pull
./deploy.sh
```

`./deploy.sh` 是幂等的，会自动重新 build 并热替换容器，配置和数据不会丢。

---

## 八、常用运维命令

```bash
# 看日志
docker compose logs -f douyin-tool

# 查容器状态
docker compose ps

# 重启
docker compose restart

# 停止
docker compose down

# 完全清掉（包括镜像，下次 deploy.sh 会重新拉）
docker compose down --rmi all
```

---

## 九、（高级）OSS 中转下载

适用场景：你的服务器带宽小（1Mbps / 5Mbps），想让用户从云端 CDN 下载，不占你服务器带宽。

当前完整支持：**七牛云 Kodo**（国内最便宜的对象存储之一）。

### 9.1 注册七牛云 + 创建 Bucket

1. 注册七牛云账号 https://portal.qiniu.com/
2. 创建一个**私有**桶（Bucket），区域记住（华东 z0 / 华北 z1 / 华南 z2 / 北美 na0 / 东南亚 as0）
3. 给 Bucket 绑定一个 CDN 加速域名（七牛免费送测试域名，或自己备案的域名）
4. 在「密钥管理」拿到 AccessKey / SecretKey

### 9.2 配置 .env

```dotenv
OSS_PROVIDER=qiniu
OSS_ACCESS_KEY=你的 AK
OSS_SECRET_KEY=你的 SK
OSS_BUCKET=你的 bucket 名
OSS_REGION=z2                                      # 看你的桶区域
OSS_PUBLIC_HOST=https://cdn.example.com            # 桶绑的 CDN 域名（不带尾斜杠）
OSS_OBJECT_TTL_MINUTES=30                          # 临时对象 30 分钟自动删
OSS_AUTO_MIRROR=0                                  # 0=用户点按钮才中转 / 1=每次解析自动预热
```

### 9.3 重启 + 测试

```bash
./deploy.sh
```

进入站点解析任意视频，每条媒体下方会出现两个按钮：「直接下载」和「OSS 中转下载」。点后者，文件会先被推到 OSS，再从 CDN 流回浏览器。

> 第一次先用「测试中转」按钮（管理员入口）走一次，确认链路通了再设 `OSS_AUTO_MIRROR=1`。

---

## 十、常见问题

**Q：部署完打开浏览器访问，提示"PIN 不正确"？**
A：检查 `.env` 里的 `PIN_HASH` 是不是和你输入的 PIN 对应。重新跑一遍 §2.2 的命令重新生成。

**Q：iOS 添加到主屏幕后，第一次打开是白屏？**
A：service worker 第一次注册需要打开两次，第二次就秒开。这是 PWA 通用行为。

**Q：解析返回 502 UPSTREAM？**
A：抖音风控偶尔会推一个验证页给服务器 IP。换个 IP 或稍后再试，不是代码 bug。

**Q：怎么修改 PIN？**
A：重新生成（§2.2），改 `.env`，再跑一次 `./deploy.sh`。**轮换 `AUTH_SECRET` 会让所有已登录的用户掉线**。

**Q：服务器吃多少内存？**
A：闲时约 80-120 MB，1GB 内存的小机器完全够用。

**Q：能不能不用 Docker？**
A：能，但不推荐。看 [docs/ENGINEERING.md](ENGINEERING.md) 的「部署模式」章节，自己 `npm run build && node packages/server/dist/index.js`。

---

## 十一、把这份给 AI 的话术

如果你完全没头绪，把下面这段直接发给 AI：

> 我有一台 Ubuntu 22.04 的服务器（IP: 1.2.3.4，用户 root），还有个域名 dy.example.com 已经解析到这台机器。我想部署 https://github.com/CarGuo/douyin-tool 这个项目，让我和家人能从手机桌面图标点进去用。请按照项目仓库里 `docs/AI_DEPLOY.md` 这份文档，一步一步给我可以直接复制粘贴的命令，每一步告诉我应该看到什么输出，我会把结果贴给你判断是否成功。我希望最终能从 https://dy.example.com 访问，并支持 iOS Safari 添加到主屏幕。

AI 会自动按文档流程帮你走完。如果遇到 AI 答错了，把报错回贴给它，结合本文档的"排错"小节，基本都能解决。
