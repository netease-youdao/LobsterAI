# OpenClaw 2026.8.1 网关启动自愈：插件安装记录、环境变量自动安装、硬链接

## 已确认的问题

2026-09-11 15:34 起的日志（同一份 state 目录从打包版 2026.6.1 runtime 切到 2026.8.1 runtime）里，网关先后被三类问题阻断，且 Quick Repair 对三者都无效，因为它只备份并重新生成 `openclaw.json`。

### 1. 残留的插件安装记录触发升级收敛失败（会影响真实用户）

2026.8.1 首次启动会执行 upgrade convergence：对已安装索引中的每条 install record 做 npm 修复和 smoke check，修复类 warning 没有 `pluginId`，一律阻断 ready。

- `src/commands/doctor-config-preflight-plugin-verification.ts`：`runStartupUpgradeConvergence` 把 `repair.warnings` 全部视为 blocking。
- `src/commands/doctor/shared/missing-configured-plugin-install.repair.ts`：install dir 缺失的记录进入 `missingRecordedPlugins`，走 `updateNpmInstalledPlugins`。
- 记录存放在共享 SQLite `state/state/openclaw.sqlite` 的 `config_machine_state['plugins.installedIndex']`，不在 `openclaw.json` 里，LobsterAI 的配置重写碰不到它。

现场记录：`nsp-clawguard`，`source: npm`，`spec: nsp-clawguard@2.4.13`，`installPath: <state>/extensions/nsp-clawguard`，2026-08-17 写入。该目录已不存在，实际生效的是 LobsterAI 自己目录下的 2.5.0。`nsp-clawguard` 不在公共 npm 上，修复必然失败并阻断。

LobsterAI 自身会制造这种不一致：`src/main/plugins/pluginManager.ts` 的 `uninstallPlugin` 直接删除 `<state>/extensions/<id>` 目录，但不通知 OpenClaw 退休记录。旧版安装流程曾对真实 state 目录执行 `openclaw plugins install`，也会留下记录。凡通过旧版 LobsterAI 装过插件、或卸载过 OpenClaw 自装插件的用户，升到 2026.8.1 都会撞上。

### 2. 环境变量触发官方插件自动安装和 capability consent（Windows 和终端启动场景会影响用户）

`src/main/libs/openclawEngineManager.ts` 用 `...process.env` 构造网关环境。2026.8.1 会按官方 provider 目录扫描环境变量，命中即把对应插件当作已配置去安装：

- `src/plugins/official-external-plugin-catalog.ts`：`resolveOfficialExternalProviderPluginIdsForEnv`。
- `src/commands/doctor/shared/missing-configured-plugin-install.ids.ts`：`collectConfiguredPluginIds` 只排除 `plugins.deny` 和 `enabled: false` 的条目，不看 `plugins.allow` 严格白名单。

目录里共 49 个变量名，包括 `DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY`、`QWEN_API_KEY`、`GROQ_API_KEY`、`MISTRAL_API_KEY`、`KIMI_API_KEY`、`VYDRA_API_KEY` 等。现场是开发者 `~/.zshrc` 导出的 `VYDRA_API_KEY`，网关已在 `state/npm/projects/openclaw-vydra-provider-*` 装了一份，然后卡在 consent。安装失败（例如 npm 不可达）同样是 blocking warning。

macOS 从 Finder 启动不继承 shell rc，OpenClaw 的 login shell 导入默认关闭（`OPENCLAW_LOAD_SHELL_ENV`），LobsterAI 也没有导入 shell env；但 Windows 的用户级环境变量会直接继承，终端启动的 macOS 也会。

### 3. 插件 manifest 变成硬链接被拒绝（构建与 QA 链路问题）

2026.8.1 通过 `@openclaw/fs-safe` 读 manifest，`nlink > 1` 直接拒绝（`path-policy.js`），报 `unsafe plugin manifest path ... (validation)`。electron-builder 在 `CI` 为真或 `USE_HARD_LINKS=true` 时用硬链接复制 extraResources（`builder-util/out/fs.js`）。本地跑 mac payload QA 后，`vendor/openclaw-runtime/mac-arm64/third-party-extensions/*/openclaw.plugin.json` 与 `.work/mac-payload-qa-*/LobsterAI.app/...` 共享 inode。

feishu 与 wecom 的校验错误是它的连带后果：`openclaw-lark` 的 feishu schema 只是 `{"type":"object"}`；manifest 被拒后 core 退回内置官方 feishu schema 严格校验，`replyMode`、`blockStreaming`、`footer` 被判非法，`streaming` 要求 object；wecom 插件被拒后 channel id 成为 unknown（`src/config/validation.ts`）。

DMG 安装和自动更新落盘的都是普通文件，用户安装包不受影响；但 CI 或本地 `dist/` 里的 `.app` 直接运行会失败，用 `cpSync` 覆写也不会解除硬链接。

### 4. LobsterAI 侧的失败处理放大了问题

- `OPENCLAW_CONFIG_STARTUP_FAILURE_PATTERNS` 只识别 invalid config；doctor 的 `refusing to report the gateway ready` 被当普通 crash 盲重启 5 次，每次重跑 npm 修复。
- 三次不干净启动后 OpenClaw 的 crash-loop breaker 触发（`src/infra/gateway-boot-lifecycle.ts`，窗口 5 分钟），期间 channel 不自动启动，UI 没有提示。

## 本次修复

### A. 启动前对齐 OpenClaw 插件安装索引

新增 `src/main/libs/openclawPluginIndexReconcile.ts`，在 bootstrap 中于 runtime 就绪、`migrateLegacyStateBeforeStartup` 之后、config sync 与 fork 之前执行；Quick Repair 复用同一步骤。

1. 只读方式读取 `state/state/openclaw.sqlite` 的 `config_machine_state['plugins.installedIndex']`，取 `index.installRecords`。不直接写该表。
2. 判定为失效记录：`installPath` 在磁盘上不存在；或插件 id 由 LobsterAI 拥有（存在于 `userData/third-party-extensions/<id>` 或 `user_plugins`）而记录指向 `<state>/extensions`。
3. 通过打包的 CLI 逐条退休：`openclaw plugins uninstall <id> --force --keep-files`，环境为 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH`、`ELECTRON_RUN_AS_NODE=1`，网关必须处于停止状态（bootstrap 已保证）。`--force` 跳过 TTY 确认，`--keep-files` 不删目录。
4. 该命令会同时从 `openclaw.json` 移除 entry/allow 等策略字段，因此必须在 config sync 之前运行，让 sync 重新生成完整配置。
5. 步骤失败只记 `[OpenClawPluginIndex]` error 并继续启动，由网关给出精确错误；成功时记录退休数量。
6. 修改 `pluginManager.uninstallPlugin`：删除 `<state>/extensions/<id>` 前先执行同一条 CLI，避免继续制造失效记录。`installPlugin` 的 staging 流程使用独立 `OPENCLAW_STATE_DIR`，记录不会泄漏到真实索引，保持不变。

`state/npm/projects/*` 属于 OpenClaw 自管的 npm 工程，本次不清理；env 触发被切断后，它们只会作为未配置插件被 smoke check 跳过。

### B. 切断环境变量驱动的自动安装

不能用 `plugins.deny`：OpenClaw 会用已发现插件校验 deny id，`openclawConfigSync.ts` 已为此把 deny 清空。

采用版本化 patch `scripts/patches/v2026.8.1/openclaw-official-plugin-targets-respect-allowlist.patch`：当 `plugins.allow` 非空时，`collectConfiguredPluginIds` 与 `configMayRequireStartupPluginConvergence` 中由环境变量或官方目录推导出的目标只保留白名单内的 id。补丁语义是"严格白名单同样约束自动安装"，可向上游提交。

备选方案是启动时从 runtime 自带的官方目录读取 49 个变量名并从网关环境中剔除。副作用是网关派生的 skills 和 MCP server 也拿不到这些变量，可能破坏用户自己的工具，因此不作为默认方案。

### C. 打包产物不含硬链接

1. `scripts/openclaw-mac-payload.cjs` 在 prune 之后遍历 `Resources/cfmind`，对 `nlink > 1` 的普通文件用临时文件加 rename 重新落盘，复用现有 override 替换 inode 的写法；Linux afterPack 同样处理。
2. 新增 `tests/openclawRuntimeHardlinks.test.ts`：在临时目录构造硬链接夹具，验证处理后所有文件 `nlink === 1` 且内容与权限不变。
3. `dist:*` 脚本显式设置 `USE_HARD_LINKS=false` 作为双保险。
4. `mac-runtime-payload.md` 记录：QA 打包不得从 `vendor/` 硬链接；开发树一旦出现 `nlink > 1`，只能删除持有另一端的 QA 目录，覆写无效。

### D. 失败识别与修复入口

1. `openclawEngineManager.ts` 新增不可重试模式：`refusing to report the gateway ready`、`unsafe plugin manifest path`。命中后不再盲重启，状态进入 error，overlay 显示网关原始错误段落。
2. Quick Repair 在重新生成配置前先执行 A；重启后若网关输出 `restart-loop breaker tripped`，在状态栏提示 IM 通道会在 5 分钟内自动恢复。是否主动调用 `channels.start` 留待后续。

## 验证

- Vitest：A 的失效判定（缺目录、LobsterAI 拥有、正常记录三类夹具）；D 的模式匹配；C 的硬链接处理。
- 手动：本机先删除 `.work/mac-payload-qa-*` 让 vendor manifest 恢复 `nlink=1`；保留现有 `nsp-clawguard` 记录与 `VYDRA_API_KEY` 启动，预期主日志出现 `[OpenClawPluginIndex] retired 1 stale install record(s)`，网关日志不再出现 Doctor warnings 块，`waitForGatewayReady: gateway healthy`。
- 打包：`npm run dist:mac` 后对 `dist/mac-arm64/LobsterAI.app/Contents/Resources/cfmind` 统计 `nlink > 1` 的文件数为 0，直接运行该 `.app` 网关可启动。
- 补丁：`npm run openclaw:patch` 后 `npm test -- openclaw` 通过，安装包补丁清单包含新条目。
