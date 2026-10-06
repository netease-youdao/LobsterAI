# OpenClaw v2026.8.1 迁移适配审查

审查基线：`origin/feat/openclaw-v2026.8.1`，`e3e21e589`；上游版本 `v2026.8.1`，提交 `ea806575e6450e4d1efdfc72c19f04be982a1b9b`。审查时间：2026-09-09。

结论：此次工作区报错是确定的迁移遗漏，已在本分支修复。其它数据也存在遗漏，尤其是 LobsterAI 仍直接读写旧 JSON、而 OpenClaw 已只使用 SQLite 的路径。不能把一次 `doctor --session-sqlite import` 当作整个运行时升级迁移已经完成。

本次只修复工作区初始化状态和工作区证明的迁移。以下其它发现仅审查，不改变它们的数据、权限或运行行为。日志包不含完整用户 state，因此代码层面的风险不等于已经在这台 QA 机器发生。

## 本次修复

`openclawEngineManager` 在会话迁移后、启动网关前运行独立工作区迁移工具。新工具构建时直接使用 pinned OpenClaw 的 `detectLegacyWorkspaceState` / `migrateLegacyWorkspaceState`，不执行通用 Doctor 的 IM 配置修复，也不加载用户插件。

- 使用与网关一致的 home / state / config，以及全部配置 Agent 的工作区映射。
- 复用上游对旧 setup 文件、attestation、路径别名和中断认领文件的处理；不自行删标记绕过检查。
- 迁入 SQLite 后重新检测遗留来源；有警告、残留、进程错误或缺失结果时，阻止进入网关就绪状态并保留可重试错误。
- 原有工作区 Markdown 文件、IM 配置、模型配置和配置锁不在该工具的写入范围。
- 普通启动与一键修复后的重新启动共用该步骤；没有旧状态时跳过写入。
- 迁移工具随 `openclaw:bundle` 构建。SQL schema 按上游生产构建方式内嵌，避免依赖源码目录中的 SQL 文件。打包检查要求工具存在，不能只编译 Electron 而继续使用缺少工具的旧 runtime。

隔离验证：多 Agent、两种旧 setup 路径、初始化时间保留、10 个 Markdown 文件内容保留、空配置锁保持不变、损坏 JSON 保留并可重试、迁移认领文件恢复、owned attestation 迁移、无关 sibling 文件保留、无旧状态不创建数据库。真实 Windows gateway 验证了“迁移前对话报错且模型请求为零 → 停止网关并迁移 → 同配置对话成功返回本地模拟模型回复”。运行中的网关会让迁移因维护锁而拒绝；再次执行迁移会跳过。

## 优先跟进的确定问题

| 项目 | LobsterAI 当前路径 | 上游变化和实际影响 | 验证程度 |
| --- | --- | --- | --- |
| IM 配对和已批准发送者 | `src/main/im/imPairingStore.ts` 读写 `credentials/<channel>-pairing.json`、`*-allowFrom.json`；`src/main/main.ts` 的配对 IPC 仍调用它 | `src/pairing/pairing-store.ts` / `pairing-store-sqlite.ts` 已使用 `channel_pairing_requests`、`channel_pairing_allow_entries`。旧白名单不进入运行时；新版配对申请不显示在当前配对管理界面。即使一次导入旧数据，后续继续写 JSON 仍会分叉 | 隔离复现：LobsterAI 读到旧白名单 1 条，上游读到 0 条；上游创建新申请 1 条，LobsterAI 读到 0 条。没有连接真实 IM |
| xAI OAuth / 旧 auth profiles | `src/main/libs/xaiAuth.ts` 的状态查询、登录保存和退出登录仍基于 `agents/main/agent/auth-profiles.json` | 上游 `src/agents/auth-profiles/store.ts` 不再从这些旧 JSON 提供运行时凭据。只有旧凭据而规范存储为空时抛 `AuthProfileMigrationRequiredError`；已有规范凭据时，后写入旧 JSON 的登录变更也不会更新规范存储。退出登录和 UI 状态也需一起改到规范存储 | 使用虚拟 OAuth 数据复现了 `requires legacy credential migration`。未执行真实 OAuth 登录、刷新或退出 |
| 执行审批存储与路径 | `src/main/libs/openclawConfigSync.ts` 的 `ensureExecApprovalDefaults()` 仍写 `<OPENCLAW_HOME>/.openclaw/exec-approvals.json` | 新版规范存储为共享 SQLite 的执行审批表；`resolveExecApprovalsPath()` 在设置 `OPENCLAW_STATE_DIR` 时检测 `<stateDir>/exec-approvals.json`。目前写入既不更新规范存储，也与上游检测路径不一致。若有效 stateDir 存在旧审批文件，运行时审批读取会被迁移检查拦截 | 隔离复现有效 stateDir 下旧审批文件触发 `ExecApprovalsMigrationRequiredError`。默认 `full/off` 恰好与新版默认值一致，所以当前过时写入不一定表现为用户故障；不能据此认定权限同步有效 |

建议分别修复以上存储适配，并覆盖旧数据导入以及迁移后的持续读写。尤其是 IM 配对，不能只补一次导入而保留旧 JSON 管理界面。

## 其它迁移范围和覆盖边界

本表对照上游 `src/infra/state-migrations.types.ts` 的 `LegacyStateDetection`、`state-migrations.doctor.ts` 的检测/执行步骤，以及 LobsterAI 启动代码。部分名称虽然叫 `autoMigrate...`，也只由 Doctor 流程调用，不能仅凭函数名推断网关启动会执行。

| 类别 | 当前覆盖或潜在遗漏 | 影响与后续检查 |
| --- | --- | --- |
| 旧 session index / transcript | 已有 `openclawSessionLegacyMigration.ts` 调用官方 session import。前置检测只找 state 根和 `agents/*/sessions/sessions.json` | 常规存储已覆盖；自定义 session store、只剩 transcript 的情况不能据此前置检测保证覆盖。应加升级样本验证，不把本轮工作区修复解释为解决全部历史会话异常 |
| 已有 Agent SQLite 的媒体、参与者身份、transcript directives、旧 schema | 上游有独立的 `state-migrations.media-persistence.ts`、Agent schema maintenance 和历史 transcript 迁移。部分是停止写入者后的显式迁移 | 如果机器已经用过中间版本 SQLite，而旧 `sessions.json` 已消失，当前 session import 检测可能直接跳过。需用受支持的旧 schema 样本验证；潜在影响包括启动、媒体和会话访问被拒绝。本轮不操作未知 schema |
| 旧 main session keys / managed worktree session 元数据 | 上游 `src/config/sessions/startup-migration.ts` 仍执行部分 SQLite 启动维护 | 有上游覆盖，和旧文件导入不同；存在自定义目录、未完成迁移 claim 时仍需看具体警告 |
| cron JSON / JSONL | 已有 `openclawCronLegacyMigration.ts`，发现旧 cron 后用临时配置运行 Doctor 并归档 | 常规 cron 已覆盖；该临时配置只明确 gateway / cron，不包含全部 Agent 映射，也仅在有旧 cron 时执行，不能用来保证其它类别已迁移 |
| FTS-only 记忆索引、LobsterAI 工作区文件搬迁 | 已有 `openclawMemoryIndexMigration.ts`、`openclawWorkspaceMigration.ts`、AGENTS 身份内容迁移 | 属于已有适配；这些迁移不包含本次修复的上游 setup / attestation SQLite 状态 |
| 设备身份与 device auth | 上游存在 `state-migrations.device-identity.ts` / `device-auth.ts`；运行时存在旧文件拒绝检查，node-host 另有自己的启动迁移 | LobsterAI 主网关客户端显式 `deviceIdentity: null`，所以不能把设备旧文件推断为本次聊天的根因；其它设备、节点和 CLI 路径仍应检查 |
| 通用 provider auth / shared auth store | Doctor 有 shared-auth-store 和旧 auth profiles 来源处理 | 不限于 xAI，保留旧 OAuth/auth JSON 的升级用户可能受影响。配置中直接提供 API key 的工作路径成功，不能证明所有 OAuth 路径成功 |
| 插件安装索引、插件 state sidecar | LobsterAI 有 `openclawPluginInstallMigration.ts` 处理旧 `plugins.installs` 配置；上游另外有旧 install index JSON 和 plugin state sidecar 迁移 | 迁移旧配置声明、导入旧插件数据、官方插件信任来源是三件不同的事。分别检查，不能以删除旧配置字段作为全部插件迁移完成的证据 |
| IM channel pairing、插件绑定审批、current-conversation bindings、插件自定义 Doctor state plans | 上游有独立迁移步骤和插件提供的状态迁移合约；本轮 workspace-only 工具不会执行 | IM 配对读写分叉已复现，其它绑定/插件存储需结合使用中的官方或第三方插件验证。不能无条件批量执行未知用户插件的 Doctor hook |
| delivery / session-delivery queues、task-runs / flow-runs sidecars | 上游 Doctor 有旧队列和任务 sidecar 导入；当前 LobsterAI 未有独立、无条件对应调用 | 持有旧待投递消息或任务数据时存在恢复遗漏风险，不能只测试新会话。日志中未证实 QA 有这类旧文件 |
| MCP OAuth、managed outgoing images、ACP replay ledger、meeting transcripts | 上游有各自的 Doctor 专属状态迁移 | 对使用过这些功能的升级用户，应验证原授权、附件、回放和转录仍可用。当前日志不足以判定是否受影响 |
| 旧 subagent registry、rescue-pending、managed worktree registry | 上游部分操作会记录“丢弃旧瞬态状态”，并非导入全部原记录 | 不宜把“补齐所有迁移”实现成无条件通用 Doctor。应区分可保留的业务数据和上游明确废弃的瞬态状态，审查后再实施 |
| voice wake、update-check、config-health、TUI last sessions、commitments、audit logs、debug-proxy capture、APNs、Web Push、node-host config、restart sentinel | 已列入上游迁移清单；不同 owner 的启动行为和使用范围不同 | 多项并非 LobsterAI 常规桌面对话的直接依赖。本次未在 QA 日志中证实其阻塞；后续升级样本应按功能选择，而不是声明全部已安全迁移 |

## 本次修复的边界

关闭 `nsp-clawguard` 后暴露出的工作区状态错误已验证可修复；Discord 插件启动/信任问题和零字节 `openclaw.json.lock` 不在本分支修改范围。工作区迁移可以在保留空配置锁时成功，但不会修复配置写入超时。

自动回归只在临时目录写入状态；真实 gateway 验证使用本地模拟模型和虚拟凭据，没有访问真实模型服务或用户工作区。尚未制作发布安装包，也未在 macOS / Linux 实机运行。

验证入口：构建 runtime 后，设置 `OPENCLAW_WORKSPACE_MIGRATION_RUNTIME` 指向它，再运行 `npm test -- openclawWorkspaceStateMigration`。未设置时，常规单元测试仍执行，依赖真实 runtime 的集成测试明确跳过。
