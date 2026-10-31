# Tailscale HTTPS 访问

目标：家人手机在任何网络下都能打开「今日菜单」，但不把服务暴露到公网。
Tailscale 免费版即可满足：设备加入同一 tailnet 后互相可达，
域名 `https://<你的节点名>.<你的tailnet>.ts.net` 由 Tailscale 自动签发证书。

## 1. 先用局域网访问

同一 Wi-Fi 下直接开 `http://<NAS内网IP>:8787`，这条路不需要 Tailscale。

**但**浏览器要求「安全上下文」才允许 ① 把网页安装到主屏幕（PWA）
② 用剪贴板 API 一键复制采购清单。局域网 IP 走的是 http，这两项会被禁用
（复制有降级方案，仍可用）。想要完整体验，走下面的 HTTPS。

## 2. 前提：NAS 上已装 Tailscale

安装与登录参见 Tailscale 官方文档（支持群晖 / QNAP / 纯 Linux Docker 宿主机等）。
确认在线：

```bash
ssh <nas> 'tailscale status'
```

## 3. 开启 HTTPS

### 3.1 在 Tailscale 后台开启证书

浏览器登录 <https://login.tailscale.com/admin/dns>，把这两项打开：

- **MagicDNS** → 开启
- **HTTPS Certificates** → 开启

这一步必须在网页后台点，命令行开不了。不开的话下一步会报
`HTTPS is not enabled in this tailnet` 之类的错。

### 3.2 在 NAS 上加一条反代

```bash
ssh <nas>

# 让 Tailscale 终止 TLS，反代到本机 8787（应用容器）
tailscale serve --bg --https=443 http://127.0.0.1:8787

# 看配置
tailscale serve status
# https://<节点名>.<tailnet>.ts.net (tailnet only)
# |-- / proxy http://127.0.0.1:8787

# 验证
ssh <nas> 'curl -sS -o /dev/null -w "%{http_code}\n" https://<节点名>.<tailnet>.ts.net/'
# 200
```

#### 反代场景记得开 TRUST_PROXY=1

走了反代之后，所有家人的请求对应用来说都来自同一个来源（代理 IP）——
AI 接口的按 IP 限流会把一家人算成同一个来源。
在 NAS 安装目录的 `.env` 里加一行，然后重建容器：

```bash
TRUST_PROXY=1
```

开启后应用改用 `X-Forwarded-For` 里的真实客户端 IP 按人限流。
只在确有反代时开启：**直连暴露时绝不能开**，否则可以伪造该头绕过按 IP 限流。

之后任何加入同一 tailnet 的设备都能访问：

```
https://<节点名>.<tailnet>.ts.net/
```

证书由 Tailscale 自动签发续期，不用买域名或配 Nginx/Caddy。

取消：`tailscale serve --https=443 off`

## 4. 一个前提：域名只在 tailnet 内可解析

Tailscale 的域名只在**加入同一 tailnet** 的设备上能解析和路由。也就是说：

- 家人手机也装了 Tailscale 并登录同一账号 → 出门在外也能用
- 家人手机没装 Tailscale → 只能在家用第 1 步的局域网地址
- 没加入的电脑（如开发机）直接开这个域名会连不上——装并登录 Tailscale 即可

## 5. 装到手机主屏幕

1. Safari 打开上面的 HTTPS 地址
2. 分享 → 「添加到主屏幕」
3. 打开后就是全屏应用，离线也能打开壳

Android Chrome 会直接弹出「安装应用」提示。

## 6. 新订单推送到手机

在应用内「汇总 → 右上角设置 → 通知」里打开开关，二选一：

- **Bark**（iOS，免费）：App Store 装 Bark，复制得到的 key 填进去。
  自建 Bark 服务时直接填完整地址（如 `https://<节点名>.<tailnet>.ts.net/<key>`）。
  服务端默认拒绝指向 localhost / 内网 IP 的自建地址（防 SSRF），
  确有需要时设 `BARK_ALLOW_PRIVATE_HOSTS=true`。
- **Server酱**：登录 `sct.ftqq.com` 获取 SendKey，填进去后通过微信接收。

推送失败不会影响下单，服务端已做超时与静默降级。

## 7. 运维速查

```bash
# 服务状态与日志
ssh <nas> 'docker ps --filter name=mealtime'
ssh <nas> 'docker logs -f mealtime'

# 更新代码：在开发机上跑
npm run deploy:nas
```

备份方案见仓库根目录 `README.md` 的「备份」章节；
在任一台 tailnet 设备上 rsync 拉一份异地副本也很方便：

```bash
rsync -avz <nas>:/<应用安装目录>/data/ ~/Backups/mealtime/
```
