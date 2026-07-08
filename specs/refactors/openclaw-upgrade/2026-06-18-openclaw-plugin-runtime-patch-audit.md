# OpenClaw plugin runtime patch audit

## 1. 背景

OpenClaw 升级到 `v2026.6.1` 后，LobsterAI 通过 `scripts/ensure-openclaw-plugins.cjs` 安装第三方 IM 插件，并在安装后对部分插件做 LobsterAI 侧兼容 patch。

2026-06-18 调试微信扫码登录时发现，OpenClaw gateway 已加载 `openclaw-weixin` 插件，但 `web.login.start` 仍返回：

```text
web login provider is not available
```

进一步确认原因不是插件未加载，而是实际 runtime 加载的编译产物缺少 provider discovery 需要的 `gatewayMethods` 声明。该问题暴露出一个通用风险：安装脚本中的某些 post-install patch 只修改 `src` 文件，但 OpenClaw gateway 实际加载的可能是 `dist` 产物或 root bundle。

## 2. 关键发现

### 2.1 微信插件 runtime 入口

当前 `openclaw-weixin/package.json` 同时声明：

```json
{
  "openclaw": {
    "extensions": ["./index.js"],
    "runtimeExtensions": ["./dist/index.js"]
  }
}
```

OpenClaw gateway runtime 使用 `runtimeExtensions`，因此微信运行路径是：

```text
openclaw-weixin/dist/index.js
openclaw-weixin/dist/src/channel.js
openclaw-weixin/dist/src/messaging/process-message.js
```

只 patch `openclaw-weixin/src/...` 不足以影响 gateway runtime 行为。

### 2.2 高风险 patch

`openclaw-weixin dmPolicy from config` 原本只修改：

```text
openclaw-weixin/src/messaging/process-message.ts
```

但实际运行文件：

```text
openclaw-weixin/dist/src/messaging/process-message.js
```

仍然包含硬编码：

```javascript
dmPolicy: "pairing",
configuredAllowFrom: [],
```

这会导致即使 `openclaw.json` 中配置了 `dmPolicy: "open"` 与 `allowFrom: ["*"]`，微信入站消息仍可能按 pairing 策略被判定为 unauthorized 并被丢弃。

## 3. 已处理改动

### 3.1 微信扫码登录 provider discovery

已在 `scripts/ensure-openclaw-plugins.cjs` 中让 `openclaw-weixin gatewayMethods` patch 同时覆盖：

```text
openclaw-weixin/src/channel.ts
openclaw-weixin/dist/src/channel.js
```

当前本地 runtime 的 ignored 产物也已同步修正：

```text
vendor/openclaw-runtime/win-x64/third-party-extensions/openclaw-weixin/dist/src/channel.js
```

修复后 channel plugin 暴露：

```javascript
gatewayMethods: ["web.login.start", "web.login.wait"]
```

### 3.2 微信 dmPolicy from config

已在 `scripts/ensure-openclaw-plugins.cjs` 中把 dmPolicy patch 抽成 `patchWeixinDmPolicy()`，并同时覆盖：

```text
openclaw-weixin/src/messaging/process-message.ts
openclaw-weixin/dist/src/messaging/process-message.js
```

当前本地 runtime 的 ignored 产物也已同步修正：

```text
vendor/openclaw-runtime/win-x64/third-party-extensions/openclaw-weixin/dist/src/messaging/process-message.js
```

修复后 `resolveSenderCommandAuthorizationWithRuntime()` 与 `resolveDirectDmAuthorizationOutcome()` 使用 `deps.config.channels["openclaw-weixin"]` 中的 `dmPolicy`，并从同一配置读取 `allowFrom`。

### 3.3 微信 allowFrom 通配符

后续复测发现，微信扫码登录和轮询均正常，但从移动端微信发送消息后 LobsterAI 没有任何响应。OpenClaw gateway 日志显示消息已经进入微信插件，但在分发到 LobsterAI 会话前被授权层丢弃：

```text
[87beb752b073-im-bot] inbound message: from=o9cq80xLqr83VS4fLmvm8JXW6hfI@im.wechat types=1
authorization: dropping message from=o9cq80xLqr83VS4fLmvm8JXW6hfI@im.wechat outcome=unauthorized
```

当时磁盘上的实际运行配置已经是开放策略：

```json
{
  "channels": {
    "openclaw-weixin": {
      "enabled": true,
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  }
}
```

根因是上一节的 post-install patch 只让插件从 `channels.openclaw-weixin` 读取 `dmPolicy` 和 `allowFrom`，但插件传给 OpenClaw 授权 helper 的发送者匹配函数仍然只做精确匹配：

```typescript
list.length === 0 || list.includes(id)
```

因此 `allowFrom: ["*"]` 会被视为一个非空 allow list，但 `*` 又不会匹配具体发送者 ID，最终得到 `senderAllowedForCommands=false`，私聊消息被判定为 `unauthorized`。这不是 IM 入站图片 metadata 展示逻辑导致的；消息在进入 LobsterAI history/UI 之前已经被插件拒绝。

已在 `scripts/openclaw-plugin-patches/weixin.cjs` 中新增 `patchWeixinAllowFromWildcard()`，同时覆盖：

```text
openclaw-weixin/src/messaging/process-message.ts
openclaw-weixin/dist/src/messaging/process-message.js
```

修复后的匹配逻辑为：

```typescript
list.length === 0 || list.includes("*") || list.includes(id)
```

兼容性结论：

1. 精确 allow-list 行为保持不变。
2. 空 allow list 仍保持插件原有的宽松语义。
3. `allowFrom: ["*"]` 现在与 LobsterAI config sync 写入的 `dmPolicy: "open"` 语义一致。
4. 已运行 `npm run openclaw:plugins` 同步当前本地 runtime；运行中的 OpenClaw gateway 仍需重启后才会加载补丁后的插件代码。

## 4. 其它 patch 风险评估

### 4.1 低风险

`openclaw-weixin/openclaw.plugin.json` startup activation patch 修改 manifest：

```text
openclaw-weixin/openclaw.plugin.json
```

OpenClaw 启动时扫描 manifest，该 patch 不涉及 `src`/`dist` 入口差异。

`openclaw-lark deferred startup loading` patch 修改 `package.json` 并生成 `setup-entry.js`，属于 loader 元数据路径，不涉及编译产物旁路。

`openclaw-lark Content-Disposition filename encoding` patch 修改：

```text
openclaw-lark/src/messaging/outbound/media.js
```

当前飞书插件包没有 `dist/` 目录，运行代码就是 `src/**/*.js`，因此不像微信插件存在 `runtimeExtensions -> dist` 的旁路。

### 4.2 已转为实际问题：DingTalk 入站图片路径

2026-06-18 14:21 的钉钉图片消息命中该风险。日志中的会话为：

```text
agent:main:dingtalk-connector:9da198db:direct:02031509112326404115
```

钉钉插件下载图片后传给 agent 的路径为：

```text
C:/Users/yangwn/.openclaw/workspace/media/inbound/openclaw-media-1781763714048-dmsfnl.jpg
```

模型第一次调用 `image` 工具时失败：

```text
Local media path is not under an allowed directory:
C:\Users\yangwn\.openclaw\workspace\media\inbound\openclaw-media-1781763714048-dmsfnl.jpg
```

根因是 `dingtalk-connector/src/utils/agent.ts` 中的 `resolveAgentWorkspaceDir()` 仍按旧结构解析 workspace：

1. 只检查 `agents.list[].workspace`。
2. 如果没有命中，main agent 回退到 `~/.openclaw/workspace`。

但 LobsterAI 在 OpenClaw 6.1 下生成的配置将 main workspace 写在：

```text
agents.defaults.workspace
```

实际配置示例：

```text
C:\Users\yangwn\AppData\Roaming\LobsterAI\openclaw\state\workspace-main
```

因此钉钉入站图片被放到了 OpenClaw 当前本地媒体白名单之外。agent 后续只能通过 `exec` 手动复制到 `C:\Users\yangwn\lobsterai\project` 后再调用 `image` 工具。

已在 `scripts/ensure-openclaw-plugins.cjs` 中新增 `dingtalk-connector agent workspace resolver` patch，同时覆盖：

```text
dingtalk-connector/index.js
dingtalk-connector/src/utils/agent.ts
```

其中 `index.js` 是 OpenClaw 实际加载入口；当前本地 ignored runtime 的 `index.js` 也已直接同步修正。

修复后的 resolver 行为：

1. 优先使用 `agents.list[].workspace`。
2. main/default agent 使用 `agents.defaults.workspace`。
3. 非 main agent 在有 defaults workspace 时落到 `${defaults.workspace}/${agentId}`。
4. 仅在没有 defaults workspace 时保留旧的 `~/.openclaw/workspace` / `~/.openclaw/workspace-${agentId}` fallback。

### 4.3 仍暂不修改：DingTalk 其它 patch

`dingtalk-connector file:// URL fix` 与 `dingtalk-connector account wildcard bindings` 当前脚本修改：

```text
dingtalk-connector/src/core/message-handler.ts
```

但钉钉插件 manifest 指向：

```text
openclaw.extensions: ["./index.js"]
```

当前本地 `index.js` 中已经能看到对应修复逻辑，因此这两项暂不修改。后续如果升级钉钉插件版本，需要重新确认 `index.js` 是否仍包含相同逻辑。

## 5. 钉钉复现场景

### 5.1 Windows file:// URL

复现目标：验证图片消息下载后的本地文件 URL 是否能被 agent 正确读取。

场景：

1. 在 Windows 上启用 DingTalk connector。
2. 给钉钉机器人发送一条图片消息。
3. 插件下载图片到本地路径，例如 `D:\...\image.jpg`。
4. 检查传入 agent 的 markdown 是否为合法 Windows file URL。

未修复时常见形态：

```markdown
![image](file://D:\...\image.jpg)
```

修复后应为：

```markdown
![image](file:///D:/.../image.jpg)
```

如果未修复，agent 侧通常会拿到无效 URL，图片内容无法读取或识别。

### 5.2 accountId wildcard bindings

复现目标：验证 LobsterAI 写入的 `accountId: "*"` 平台级绑定是否能匹配具体钉钉账号。

场景：

1. 配置 DingTalk connector 至少一个可用账号，例如实际账号 ID 为 `default` 或其它具体值。
2. 在 OpenClaw config 的 `bindings` 中配置一条非 main agent 的绑定，`match.accountId` 使用 `"*"`。
3. 从钉钉向机器人发送消息。
4. 观察 gateway 日志、session key 或会话归属。

未修复时，插件使用精确匹配：

```javascript
if (match.accountId && match.accountId !== accountId) continue;
```

当 `match.accountId` 为 `"*"`、实际 `accountId` 为具体账号时，绑定会被跳过，消息落回 `cfg.defaultAgent` 或 `main`。

修复后应允许 `"*"` 匹配所有账号：

```javascript
if (match.accountId && match.accountId !== "*" && match.accountId !== accountId) continue;
```

当前本地 `dingtalk-connector/index.js` 中已存在该逻辑。

## 6. 验证记录

已执行：

```powershell
node --check scripts\ensure-openclaw-plugins.cjs
```

结果：通过。

已静态确认当前本地 runtime：

```text
openclaw-weixin/openclaw.plugin.json contains activation.onStartup=true
openclaw-weixin/dist/src/channel.js contains gatewayMethods
openclaw-weixin/dist/src/messaging/process-message.js contains chanCfg_dmPolicy_patch
```

运行中 gateway 不会热加载已 import 的插件对象。验证微信扫码登录和微信入站消息前，需要重启 OpenClaw gateway 或整个 Electron dev 进程。

## 7. 2026-06-18 DingTalk 图片显示补充

后续验证 DingTalk 图片消息时，日志又暴露出一处前端显示问题：

```text
[ArtifactPreview] local file request failed:
ENOENT: no such file or directory, stat 'D:\Users\yangwn\.openclaw\workspace\media\inbound\openclaw-media-1781763714048-dmsfnl.jpg'
```

这条日志对应截图中的破图占位。根因不是图片文件不存在，而是 `AssistantTurnBlock` 的内联媒体渲染直接拼接：

```text
localfile://${artifact.filePath}
```

当 `artifact.filePath` 是 Windows 绝对路径 `C:\Users\...` 时，浏览器会把它解释成 host 为 `C:` 的 URL，主进程 `localfile://` 协议最终收到 `/Users/...`，在当前盘上变成 `D:\Users\...`。

已在 `src/renderer/components/cowork/AssistantTurnBlock.tsx` 改为和 Markdown 图片一致的编码规则：

```text
C:\Users\...\image.jpg -> localfile:///C:/Users/.../image.jpg
```

这项修复只影响 LobsterAI 前端如何显示已检测到的本地图片 artifact；DingTalk 插件侧的入站下载目录修复仍然负责让新图片落到 OpenClaw 允许读取的 workspace 下。

## 8. 2026-06-18 Feishu 插件契约与 DingTalk 复测补充

### 8.1 Feishu 启动期插件契约错误

复测 OpenClaw gateway 启动时，Feishu 出现两类插件校验错误：

```text
channel "openclaw-lark" registration missing required config helpers
plugin must declare contracts.tools before registering agent tools
```

这不是 DingTalk 入站图片的 workspace 路径问题，而是 OpenClaw 6.1 对插件注册契约校验更严格后暴露的兼容问题。

根因：

1. LobsterAI 为降低启动耗时，给 `openclaw-lark` 生成了轻量 `setup-entry.js`，但旧内容只有静态 channel metadata，缺少 `config.listAccountIds` 与 `config.resolveAccount`。
2. `openclaw-lark/index.js` 注册了大量 `feishu_*` agent tools，但 `openclaw.plugin.json` 没有声明 `contracts.tools`。

已处理：

```text
openclaw-lark/setup-entry.js
openclaw-lark/openclaw.plugin.json
scripts/ensure-openclaw-plugins.cjs
```

`setup-entry.js` 现在提供零依赖的 Feishu account config helpers；`openclaw.plugin.json` 现在声明 Feishu 工具 contracts，避免 6.1 registry 在工具注册阶段报错。安装脚本也改为幂等刷新旧 `setup-entry.js`，不再因为 `package.json` 已有 `setupEntry` 而跳过内容升级。

### 8.2 DingTalk 图片复测结论

复测 DingTalk 后，新图片已经落到正确 workspace：

```text
C:\Users\yangwn\AppData\Roaming\LobsterAI\openclaw\state\workspace-main\media\inbound\openclaw-media-1781765235624-w5cu9j.jpg
```

这说明 `dingtalk-connector` 的 workspace resolver 修复已经生效。日志中本轮 `image` 工具调用也成功返回，旧的 `Local media path is not under an allowed directory` 没有再次出现。

仍然显示破图的原因是前端本地文件协议解析还有兜底缺口。某些渲染路径会产生旧形态：

```text
localfile://C:/Users/...
```

Electron `URL` 会把其中的 `C` 解析为 host，主进程原先只读取 `pathname`，导致最终访问：

```text
D:\Users\yangwn\...
```

已在 `src/main/main.ts` 的 `getLocalFileProtocolPath()` 中补充 Windows drive host 解析，使以下两种 URL 都解析到同一个本地路径：

```text
localfile://C:/Users/yangwn/a.jpg
localfile:///C:/Users/yangwn/a.jpg
```

该修复会覆盖历史消息或旧渲染路径产生的非规范 URL；`AssistantTurnBlock.tsx` 中的三斜杠规范化仍保留，负责减少新消息继续生成非规范 URL。

## 9. 2026-06-18 post-install patch 拆分

`scripts/ensure-openclaw-plugins.cjs` 原先同时负责插件安装、缓存复制和各渠道 post-install patch，文件尾部已经变得较长，且不同渠道的补丁逻辑混在一起。此次重构后，主脚本只保留安装流程，并在所有插件复制完成后调用：

```javascript
applyOpenClawPluginPatches({ runtimeExtensionsDir, log });
```

具体 patch 被拆到：

```text
scripts/openclaw-plugin-patches/common.cjs
scripts/openclaw-plugin-patches/index.cjs
scripts/openclaw-plugin-patches/weixin.cjs
scripts/openclaw-plugin-patches/lark.cjs
scripts/openclaw-plugin-patches/dingtalk.cjs
```

拆分后的边界：

1. `weixin.cjs` 负责 `gatewayMethods`、startup activation、`dmPolicy/allowFrom` 从 config 读取。
2. `lark.cjs` 负责 deferred startup、`setup-entry.js` config helpers、`contracts.tools`、文件名编码修复。
3. `dingtalk.cjs` 负责 Windows `file://` 图片 URL、`accountId: "*"` wildcard、workspace resolver。
4. `common.cjs` 仅提供 JSON 读写工具，避免每个渠道文件重复实现。

这次重构没有改变安装顺序，也没有让 patch 提前执行；仍然是在插件复制到 `runtimeExtensionsDir` 后统一作用于最终 runtime 目录。因此主要风险从“行为变化”转为“拆分时遗漏某个旧 patch”。已通过 `node --check` 覆盖主脚本和全部拆分模块，并用当前 runtime 目录直接调用 `applyOpenClawPluginPatches()` 做了一次幂等验证。

## 10. localfile / file URL 的 macOS 适用性

本次新增的主进程兼容逻辑是 Windows-only：

```typescript
if (process.platform === 'win32' && /^[A-Za-z]$/.test(url.host) && filePath.startsWith('/')) {
  return `${url.host}:${filePath}`;
}
```

它只处理历史或错误生成的 `localfile://C:/Users/...` 这种 URL。macOS 上的正常路径是 `/Users/...`，规范 URL 形态是：

```text
localfile:///Users/yangwn/a.jpg
file:///Users/yangwn/a.jpg
```

这种 URL 的 `host` 为空，`pathname` 保留 `/Users/...`，不会命中 Windows drive host 分支。因此该兼容逻辑不会破坏 macOS。

当前几个关键生成路径对 macOS 也是成立的：

1. `MarkdownContent.tsx` 的 `toLocalFileSrc()`：`/Users/...` 编码后仍以 `/` 开头，生成 `localfile:///Users/...`。
2. `AssistantTurnBlock.tsx` 的 `toLocalFileSrc()`：同样会把 macOS 绝对路径生成为 `localfile:///Users/...`。
3. `userMessageDisplay.ts` 的 `encodeFilePathAsMarkdownImage()`：macOS 路径生成 `file:///Users/...`。
4. `scripts/openclaw-plugin-patches/dingtalk.cjs` 的 DingTalk `file://` patch 明确只在 `process.platform === 'win32'` 时重写；macOS/Linux 保留 `file://${p}`，对 `/Users/...` 会自然得到 `file:///Users/...`。

仍需注意的风险是：代码库里还有一些解析器会手动剥离 `file://` 或 `localfile://` 前缀。已看到的核心解析器通常只在正则确认 Windows drive letter 时剥离前导 `/`，并已有 Unix path 单测覆盖；因此目前没有发现需要为 macOS 额外改动的点。后续如果发现 macOS 上的本地媒体无法显示，应优先检查是否产生了 `localfile://Users/...` 这种缺少第三个斜杠的非规范 URL。

## 11. 2026-06-22 插件升级后 post-install patch 复核

DingTalk 升级到 `0.8.23`、Lark/Feishu 升级到 `2026.6.10` 后，重新复核了 `scripts/openclaw-plugin-patches/` 下各渠道 patch 是否仍作用于 OpenClaw gateway 实际加载路径。

### 11.1 DingTalk runtime 入口变化

`@dingtalk-real-ai/dingtalk-connector@0.8.23` 的 `package.json#openclaw.extensions` 指向：

```json
["./dist/index.mjs"]
```

该版本会把 `src/core/message-handler.ts` 与 `src/utils/agent.ts` 的逻辑 bundle 到 hash 命名的 dist 文件中：

```text
dingtalk-connector/dist/message-handler-0NLKAqHU.mjs
```

因此只修改 `src/core/message-handler.ts` 或 `src/utils/agent.ts` 不足以影响实际运行时。

已调整 `scripts/openclaw-plugin-patches/dingtalk.cjs`：

1. 扫描 `dist/message-handler-*.mjs`。
2. 对 dist message handler 同步应用 Windows `file://` 图片 URL 修复。
3. 对 dist message handler 同步应用 `accountId: "*"` wildcard 修复。
4. 对 dist message handler 内联的 `resolveAgentWorkspaceDir()` 同步应用 `agents.defaults.workspace` fallback 修复。

当前 runtime 静态确认：

```text
dingtalk-connector/dist/message-handler-*.mjs contains file:///${n}
dingtalk-connector/dist/message-handler-*.mjs contains match.accountId !== "*"
dingtalk-connector/dist/message-handler-*.mjs contains dingtalk_agent_workspace_defaults_patch
dingtalk-connector/dist/message-handler-*.mjs reads cfg.agents?.defaults?.workspace
```

新增测试：

```text
tests/openclaw-plugin-patches-dingtalk.test.ts
```

覆盖 hash dist 文件发现、Windows file URL 修复、dist workspace resolver 修复。

### 11.2 Weixin patch 复核

微信插件仍声明：

```json
{
  "runtimeExtensions": ["./dist/index.js"]
}
```

`weixin.cjs` 已同时覆盖 source 与 dist：

```text
openclaw-weixin/src/channel.ts
openclaw-weixin/dist/src/channel.js
openclaw-weixin/src/messaging/process-message.ts
openclaw-weixin/dist/src/messaging/process-message.js
```

重新应用 patch 后，当前 runtime 静态确认：

```text
openclaw-weixin/dist/src/channel.js contains gatewayMethods
openclaw-weixin/dist/src/messaging/process-message.js contains chanCfg_dmPolicy_patch
openclaw-weixin/dist/src/messaging/process-message.js contains list.includes('*')
```

未发现新的 `src`/`dist` 旁路失效点。

### 11.3 Lark/Feishu patch 复核

`@larksuite/openclaw-lark@2026.6.10` 当前 `openclaw.extensions` 指向 `./index.js`，而 root `index.js` 直接 `require("./src/...")`。因此 `lark.cjs` 对 `src/messaging/outbound/media.js` 的文件名编码 patch 仍作用于实际运行路径。

重新应用 patch 后，当前 runtime 静态确认：

```text
openclaw-lark/setup-entry.js contains listAccountIds / resolveAccount
openclaw-lark/openclaw.plugin.json contains contracts.tools including feishu_doc_media
openclaw-lark/src/messaging/outbound/media.js contains fixLatin1GarbledUtf8
```

未发现新的 dist 旁路失效点。

### 11.4 验证

已执行：

```bash
node --check scripts/openclaw-plugin-patches/dingtalk.cjs
npx vitest run tests/openclaw-plugin-patches-dingtalk.test.ts
node -e "const path=require('path'); const {applyOpenClawPluginPatches}=require('./scripts/openclaw-plugin-patches/index.cjs'); applyOpenClawPluginPatches({runtimeExtensionsDir:path.join(process.cwd(),'vendor/openclaw-runtime/current/third-party-extensions'), log: console.log});"
```

注意：这些 patch 作用于 runtime 文件，但运行中的 OpenClaw gateway 不会热重载已 import 的插件模块。验证 DingTalk 图片消息、DingTalk 入站图片 workspace、微信扫码/入站授权、Feishu setup metadata 前，需要重启 OpenClaw gateway 或整个 Electron dev 进程。
