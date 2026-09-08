# OpenClaw 2026.8.1 IM 插件兼容性排查

日期：2026-09-08。基线：远端 `feat/openclaw-v2026.8.1` 的 `eb931315a`。
修复分支：`fix/openclaw-dingtalk-lark-compat`。

在独立 worktree 中复制现有 Windows runtime 进行验证。运行时版本为
`v2026.8.1`（构建记录中的上游提交为 `ea806575e6450e4d1efdfc72c19f04be982a1b9b`）。
原工作区、原 runtime 和真实机器人配置未用于写入修复或启动测试。

## 已修复

### 钉钉：`@dingtalk-real-ai/dingtalk-connector@0.8.23`

1. `dist/index.mjs` 的重复加载检测使用了
   `typeof import.meta` 和 `import.meta?.url`。当前 Windows 插件加载路径进入
   Jiti 2.7.0 后，只转换了直接访问的 `import.meta.url`，其余两种形式残留在
   CommonJS 代码中，导致 `Cannot use 'import.meta' outside a module`。
   改为 `String(import.meta.url)`，保留基于实际模块 URL 的重复加载检测，支持安装目录迁移。
2. 延迟加载的 `dist/message-handler-*.mjs` 仍引用已移除的
   `openclaw/plugin-sdk/channel-runtime`。即使入口加载成功，收到消息时仍会触发错误。
   改为公开的 `channel-outbound`，继续使用原有 reply-prefix、typing 和错误日志函数。
3. 同步修补发布包内的 `index.ts`、`src/reply-dispatcher.ts`，保持源码和 dist 一致。

### 飞书：`@larksuite/openclaw-lark@2026.7.16`

| 文件 | 原 SDK 路径 | 新 SDK 路径 | 影响 |
| --- | --- | --- | --- |
| `index.js` | `plugin-sdk` | `plugin-sdk/plugin-entry` | 恢复插件入口中的 `emptyPluginConfigSchema` |
| `src/card/reply-dispatcher.js` | `plugin-sdk/channel-runtime` | `plugin-sdk/channel-reply-pipeline` | 恢复回复前缀和 typing 回调 |
| `src/card/tool-use-config.js` | `plugin-sdk/config-runtime` | `plugin-sdk/session-store-runtime` | 恢复会话级 `/verbose` 设置读取 |

路径均以 `openclaw/` 为前缀。最后一项原先会因 `loadSessionStore` /
`resolveSessionStoreEntry` 已移出 `config-runtime` 而进入 catch，静默忽略会话设置。
2026.8.1 的 `session-store-runtime` 仍公开兼容这组调用；已用真实 SQLite 会话数据验证。

修复位于现有 `scripts/openclaw-plugin-patches/dingtalk.cjs` 和 `lark.cjs`，
由 `ensure-openclaw-plugins.cjs` 在复制插件到 runtime 后执行。补丁可重复运行。
没有修改全局 SDK bridge、OpenClaw loader、插件版本或其它 IM 的补丁。
上游加载行为参见 [v2026.8.1 插件加载器](https://github.com/openclaw/openclaw/blob/v2026.8.1/src/plugins/loader-module-runtime.ts)。

## 其它 IM：仅检查，未修改

逐个按 `openclaw.plugin.json` 中的真实插件 ID，调用当前 runtime 的完整插件加载器，
使用隔离配置完成模块加载和注册，不建立机器人连接、不收发消息。

| IM | 真实插件 ID | 检查结果 |
| --- | --- | --- |
| 云信 NIM | `nimsuite-openclaw-nim-channel` | **复现同类错误**：`index.mjs` 引用 SDK 根入口，抛出 `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| 网易 Bee | `openclaw-netease-bee` | **复现同类错误**：`index.mjs` 引用 SDK 根入口，抛出 `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| QQ | `openclaw-qqbot` | 模块加载、频道注册通过 |
| 企业微信 | `wecom-openclaw-plugin` | 模块加载、频道注册通过；其媒体 SDK 探测有 fallback，未判定为导出错误 |
| 微信 | `openclaw-weixin` | 当前 `dist/index.js` 加载、频道注册通过 |
| POPO | `moltbot-popo` | 模块加载、频道注册通过 |
| 邮箱 | `email` | 模块加载、频道注册通过 |
| Discord | `discord` | 模块加载、频道注册通过 |
| Telegram | `telegram` | bundled 插件加载、频道注册通过 |

另外记录，均未修改：

- NIM、Bee 的 manifest 缺少 `channelConfigs`，新 loader 提示配置/设置界面能力可能受限。
- 企业微信在本次最小配置下有 `before_prompt_build` hook 被拦截的提示，原因是未设置
  `plugins.entries.wecom-openclaw-plugin.hooks.allowConversationAccess=true`。
  这是 hook 权限迁移问题，不是本次的入口导出错误；需要结合产品实际权限意图另行确认。
- 微信发布包的 `dist/src/messaging/model-callback-handler.js` 仍从 `config-runtime`
  导入已移除的 `updateSessionStore`。包内未找到其它文件对该模块的引用，当前加载检查未触发它，
  因此仅记录为遗留模块风险，不能据此认定当前微信频道不可用。
- NIM 安装缓存标记为 Git `#1.1.1`，包内 `package.json` 自报 `1.0.3`；以上结论来自当前实际产物，
  没有重新拉取或替换其它 IM 插件。

## 验证和范围

- Vitest：3 个测试文件、24 项测试通过，包括新增的 SDK 导出边界、延迟导入、路径迁移、
  会话 verbose、幂等及不影响其它插件的回归用例。
- 新增 TypeScript 测试文件通过 CI 规则的 ESLint，0 warning。
- `compile:electron` 通过。
- 实际 OpenClaw loader：修复前复现两条 QA 错误，修复后两个插件均为 `loaded`，
  `diagnostics` 为空；飞书注册 29 个工具。
- 实际 Jiti 2.7.0：钉钉入口注册和延迟消息处理模块均成功加载，注册 13 个 gateway 方法。
- 实际 SDK + SQLite：飞书读取已保存的 `verboseLevel=full` 成功；内联 `/verbose off` 仍优先。
- Electron 43.5.0 / Node 24.19.0 启动隔离 gateway，日志包含钉钉、飞书，`/healthz` 返回 HTTP 200。
  使用 `OPENCLAW_SKIP_CHANNELS=1` 跳过真实连接，测试进程结束后已停止。

使用原工作区的 `node_modules` junction 运行测试和编译，因此以 `npm --ignore-scripts`
跳过会重建共享 `better-sqlite3` 的生命周期脚本，避免影响用户正在运行的 Electron。
没有运行完整测试集，也没有用真实账号验证机器人连接、消息往返、群聊和卡片展示。

隔离 worktree 的 `vendor/openclaw-runtime/current` 已指向应用补丁后的 runtime，可用于后续人工 QA。
常规 `npm run openclaw:plugins` / runtime 构建流程会自动应用这两个补丁；
已存在的其它工作区 runtime 需要重新应用补丁后重启 gateway，单独重启不会修改已安装插件文件。

本地详细验证输出位于 worktree 的 `.work/im-compat/`（不纳入 Git）：
`load-before.log`、`load-after.log`、`deferred-smoke.log`、`gateway-smoke.log`、
`other-im-load.log` 和 `other-im-load-extra.log`。
