# OpenClaw 移动端连接 LobsterAI

LobsterAI 内置 OpenClaw Gateway。官方移动端可以直接连接这一个 Gateway，无需启动第二个 OpenClaw，也无需增加协议适配服务。

## 1. 配置连接方式

退出 LobsterAI 后，编辑它的 `openclaw/state/openclaw.json`：

- macOS：`~/Library/Application Support/LobsterAI/openclaw/state/openclaw.json`
- Windows：`%APPDATA%/LobsterAI/openclaw/state/openclaw.json`
- Linux：`~/.config/LobsterAI/openclaw/state/openclaw.json`

在现有 `gateway` 对象中合并下面一种配置，保留文件中的其他字段。LobsterAI 会继续管理认证 token，并保留这里的网络配置。

### 同一 Wi-Fi / 局域网

```json
{
  "gateway": {
    "bind": "lan",
    "tailscale": { "mode": "off" }
  }
}
```

手机需要能访问电脑的局域网地址，电脑防火墙需要允许该 Gateway 端口。二维码会使用电脑的局域网 IP 和实际端口。

### 通过 Tailscale 跨网络连接

电脑和手机先安装、登录 Tailscale，并允许彼此访问。电脑上的 `tailscale` 命令需要能被 LobsterAI 找到，tailnet 需要支持 HTTPS / Serve。

```json
{
  "gateway": {
    "bind": "loopback",
    "tailscale": { "mode": "serve" }
  }
}
```

OpenClaw 管理 Tailscale Serve，手机连接 `wss://<电脑的 MagicDNS 域名>`。Serve 使用 `loopback`，不要与 `bind: "lan"` 混用。保持原生 `gateway.tls` 关闭，由 Serve 提供 HTTPS，以兼容 LobsterAI 的本机连接。

## 2. 启动并配对

1. 完全退出并重新启动 LobsterAI，等待 Gateway 就绪。若在 OpenClaw 后台修改了 `gateway.bind`，也需要这一步；当前版本的 Gateway 内部重启可能沿用旧监听地址。
2. 从同一 `state` 目录的 `gateway-port.json` 读取 `port`。端口可能因占用而变化，不要固定假设为 `18789`。
3. 在电脑浏览器打开 `http://127.0.0.1:<port>/`，进入内置的 OpenClaw Control UI。在连接设置中使用同目录 `gateway-token` 文件的内容完成本机登录。
4. 在 **Devices → Pair device** 中选择 **Limited access**，生成配对二维码。
5. 使用官方 OpenClaw 移动端扫码连接。配对码过期时重新生成。

局域网模式下，Gateway 会自动允许本机 Control UI 的来源地址，无需为手机原生连接额外设置 `allowedOrigins`。Bonjour 自动发现仍关闭，使用二维码连接即可。

如果生成二维码时报 `Gateway is only bound to loopback`，检查当前实例的上述配置文件是否已设置 `gateway.bind: "lan"`，然后完全重启 LobsterAI，再重新加载配对页面。代码支持配置不等于已经为现有实例开启局域网接入。

连接期间保持电脑和 LobsterAI 运行。移动端使用已有的 OpenClaw agent、模型和运行能力；LobsterAI 自有的 Cowork 会话展示、SQLite 元数据和产物面板不会因为网络配置而自动同步到原生移动端。

## 验证范围

本次使用内置 v2026.8.1 Gateway 和隔离临时状态验证了默认本机连接、LAN 访问、Control UI 返回、配对二维码、官方 iOS 协议的 node/operator 双连接及设备令牌重连。配置回归覆盖 LAN 和 Tailscale Serve 在同步及重新初始化后保留。未进行手机真机扫码和真实 Tailscale 网络验证。
