# 云信与网易 Bee SDK 兼容修复

基线：`feat/openclaw-v2026.8.1` 的 `72367d3b0`，已包含
[PR #2628](https://github.com/netease-youdao/LobsterAI/pull/2628) 的钉钉、飞书修复。
本次在 `D:\github\LobsterAI-im-compat` 独立 worktree 中使用
`fix/openclaw-nim-bee-compat` 分支处理云信和网易 Bee。

## 原因与改动

两个插件的预编译 `index.mjs` 都从已移除的 `openclaw/plugin-sdk` 根入口导入
`emptyPluginConfigSchema`。在 OpenClaw 2026.8.1 完整插件加载器中均可复现
`ERR_PACKAGE_PATH_NOT_EXPORTED`，分别影响：

- 云信：目录 `openclaw-nim-channel`，真实插件 ID `nimsuite-openclaw-nim-channel`。
- 网易 Bee：目录和插件 ID 均为 `openclaw-netease-bee`。

新增 `scripts/openclaw-plugin-patches/nim-bee.cjs`，将这两个插件的入口导入迁移到
`openclaw/plugin-sdk/plugin-entry`。同时修补 `index.ts` 和 `index.mjs`；
该子路径也导出入口源码所用的 `OpenClawPluginApi` 类型。
其余源码中的历史类型导入不参与运行时加载，本次没有进行类型系统重构。

补丁接入已有的 `applyOpenClawPluginPatches`，在插件从缓存复制到 runtime 后执行。
这样已有预编译缓存和重新准备的 TypeScript 包都会获得修复，无需强制下载插件。
没有改动插件版本、全局 SDK bridge、OpenClaw loader，或已推送的钉钉、飞书补丁。

## 验证

- 4 个 Vitest 文件、25 项测试通过。新增 5 项用例覆盖：两个插件的新包准备流程、
  只有预编译文件的缓存、重复执行、不修改其它插件、缺失可选插件。
  新包用例先复现旧导入的失败，再通过真实 Node 模块导入验证补丁后的频道注册。
- 新增 TypeScript 测试文件通过 CI 规则 ESLint；`compile:electron` 和脚本语法检查通过。
- 当前 Windows runtime 的完整加载器将两个插件均标记为 `loaded`，
  注册频道 `nim`、`netease-bee`，没有插件加载 error。
- 静态检查两个插件实际运行时的 SDK 命名导入，没有发现其它缺失的 SDK 导出。
- 使用当前真实 `PluginRuntime` 验证了收消息代码涉及的 11 个 API 的可用性、
  账号解析和路由：云信两个账号分别解析成功，相同发送人在不同账号下得到不同 session key；
  Bee 默认账号及路由解析成功。
- 隔离 Electron gateway 在两插件启用、跳过连接的模式下加载成功并返回 HTTP 200。
  `OPENCLAW_SKIP_CHANNELS=1` 会清除运行时的频道配置，因此另用保留账号配置、
  将账号/频道设为禁用的模式验证了配置与健康检查，HTTP 200 且没有初始健康刷新错误。
  所有测试 gateway 已停止，未连接真实机器人或发送消息。

测试和编译使用 `npm --ignore-scripts`，避免生命周期脚本重建与原工作区共享的原生依赖。
本次未运行完整测试集，也未进行真实账号的端到端消息往返验证。

## 保留事项

两个上游 manifest 仍缺少 `channelConfigs`。新版 OpenClaw 因此报告配置/设置界面能力可能受限的
warning，但本次实测未阻止插件注册及已有账号配置的启动。这不属于已修复的 SDK 入口错误，
本次未为它们复制或重写配置 schema。

云信在完全没有 `channels.nim` 配置、却仍被显式加载时，健康检查还会触发
`expected object.keys(account summaries) entry at 0 to be defined`；
本次在清除频道配置的 `OPENCLAW_SKIP_CHANNELS=1` 场景观察到该问题。
保留账号配置的验证未出现此错误。本次未扩展修改云信的空账号健康状态逻辑。

worktree 的 `vendor/openclaw-runtime/current` 已应用本次补丁，可继续进行 QA：

1. 云信单账号和双账号连接、私聊、群聊、同一发送人的账号隔离。
2. 网易 Bee 连接、接收文本、回复文本和重新连接。

详细本地输出保存在 `.work/im-compat/nim-bee-load-after.log`、
`nim-bee-runtime-smoke.log`、`nim-bee-gateway-smoke.log`。
本次变更作为钉钉、飞书修复的后续 PR，目标分支为 `feat/openclaw-v2026.8.1`。
