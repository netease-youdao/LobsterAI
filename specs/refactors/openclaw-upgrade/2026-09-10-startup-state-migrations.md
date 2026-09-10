# OpenClaw 2026.8.1 启动迁移补齐与审计

## 已确认的问题

Mac 新日志中，20 个旧会话索引已经完成归档，26 个工作区旧状态也已处理；随后网关因 `identity/device.json` 尚未迁移而退出。该文件保存本机设备 ID 和公私钥，与日志中的“已迁移 5 个配对设备”不是同一份状态。单独完成会话迁移不能证明设备身份已迁移。

上游不是完全没有身份自动迁移。Gateway CLI 会在自动状态迁移中传入 `allowLegacyDeviceIdentityImport: true`，但普通 CLI 只创建 state checkpoint。若先运行 `memory index --force`，它可能在没有导入身份的情况下写下 state checkpoint；Gateway 随后跳过同一段自动状态迁移。现场日志的调用顺序与该路径吻合，但日志包没有 checkpoint/SQLite，不能据此断言现场一定由该检查点触发。

对应上游固定版本源码：

- `src/cli/program/config-guard.ts`：Gateway 与普通 CLI 分别要求 startup/state checkpoint。
- `src/commands/doctor-config-preflight.ts`：已有 state checkpoint 时跳过 `autoMigrateLegacyState`，仅 Gateway 授权 identity import。
- `src/infra/startup-migration-checkpoint.ts`：`needsStateMigrationCheckpoint` 与 `needsStartupMigrationCheckpoint`。
- `src/infra/device-identity.ts`：没有有效 SQLite 身份时拒绝读取遗留身份文件。

## 本次修复

将原工作区 helper 扩展为 `scripts/openclaw-startup-state-migration.mjs`，在启动网关前调用。它直接复用固定版本的专用 owner，不加载插件、不调用通用 Doctor、不改写 LobsterAI 生成的配置：

1. `identity/device-auth.json`：导入设备认证 token。
2. `identity/device.json` 及中断导入文件：导入原设备 ID 和公私钥。使用 startup import 权限，不能隐式生成替代身份。
3. `exec-approvals.json` 及中断导入文件：导入执行审批策略。该遗留文件不仅影响执行，还会阻塞 `agents.list` 和 `exec.approvals.get`。
4. 工作区 setup/attestation：保留原有专用迁移及损坏 attestation 隔离逻辑。

每次都按真实来源检查，不以版本标记或上游 checkpoint 代替。各 owner 依次取得上游状态锁、迁移和校验；随后再次检测剩余来源。任一警告、仍待迁移的来源、进程失败或不完整报告都会阻止启动并显示具体原因。不同 owner 的失败会在同一份报告中列出，避免反复启动才逐个发现。

设备身份保留上游的一个明确例外：已有有效迁移 receipt 和 canonical 身份时，owner 可以将重新出现的不同旧 JSON 作为惰性退休文件保留并给出 notice。helper 额外调用上游只读身份 reader 确认 canonical 可用，不把这种 notice 错误升级为启动失败；没有 receipt 的冲突、无效 canonical 或 native 导入占用仍会阻断。

报告包含每一类 owner 的检测数量；主进程校验清单完整性及合计。旧的仅 workspace 报告不能被当作完整启动迁移报告接受。构建脚本始终重新打包 helper，安装包检查也要求新入口存在。

## 其他流程审计

下表路径相对于 `OPENCLAW_STATE_DIR`，工作区文件除外。LobsterAI 默认值为 `userData/openclaw/state`；共享 SQLite 实际位于其下的 `state/openclaw.sqlite`。

| 状态 | 上游行为 / LobsterAI 覆盖 | 结论 |
| --- | --- | --- |
| 会话 JSON/JSONL | 上游启动拒绝旧索引；LobsterAI 已有 session-only Doctor + 归档复检 | 既有修复已在新 Mac 日志中生效 |
| Cron JSON/运行记录 | 上游有 cron repair owner；LobsterAI 已有 cron 专用适配 | 保持原流程；不能依赖它顺带迁移其他状态 |
| 设备身份、device auth、exec approvals、workspace | 有明确运行拒绝条件；通用自动流程不能完整覆盖 | 本次专用迁移补齐 |
| 设备/节点配对列表 | `gateway/server-startup-plugins.ts` 在启动中导入 | 已覆盖；与主设备身份区分 |
| 插件 KV 旧 SQLite、安装索引 JSON | `state-migrations.doctor.ts` 自动 plan 包含迁移 owner | 有自动入口，不重复实现 |
| IM pairing / allowFrom JSON | 上游自动 plan 可迁移，运行时只使用 SQLite | LobsterAI 持续读写接口有独立遗漏，见下文 |
| 模型 auth-profiles/auth JSON、旧 OAuth 凭据 | 真正导入由 `doctor-auth-flat-profiles.ts` 执行；普通自动流程不导入 | 可能使对应模型/agent 的 secrets degraded 或首次请求失败，需单独补齐与功能验收 |
| main-agent auth SQLite → shared auth SQLite | 未迁移时仍有 `legacy-main` 读取 owner | 尚未搬迁本身不等于鉴权或启动失败 |
| 插件模型目录 JSON | 模型目录 reader 调用自身 migrator | 已有读取时迁移；需验证模型列表 |
| MCP OAuth 旧 JSON | Doctor-only owner；未发现仅文件存在就全局启动失败的 gate | 对使用 OAuth 的 MCP 做授权保持验收 |
| Web Push / node-host 配置 | 有各自的 legacy gate，但在对应功能路径触发 | 条件验收，不增加所有桌面用户的启动阻断 |
| 投递队列、任务旁库、voice wake、config health、restart sentinel 等 | 自动 plan 中已有对应 owner | 对有历史数据的功能验收，不一概认定漏迁移 |
| subagent registry、APNs、meeting transcripts、审计旧日志等 | 部分为 Doctor-only 数据迁移 | 历史数据完整性验收范围；不等同本次全局启动故障 |

审计入口是上游 `src/infra/state-migrations.doctor.ts` 的 detector/step 清单，同时反查运行时 `MigrationRequired`、`doctor --fix`、legacy source gate 及实际调用者。自动 owner 的存在只证明有迁移路径，不证明所有用户数据都已成功迁移。

## 仍可能阻塞整个网关的条件

本轮未再确认一项“正常旧数据因 LobsterAI 漏接专用迁移入口而必然阻塞启动”的遗漏，但以下条件仍会阻断，不能将本次修复理解为所有异常都能降级启动：

- 核心来源损坏或冲突且无法校验、会话归档未完成、SQLite 无法读写，以及另一进程持有状态锁或 native identity 导入 claim。专用 owner 会保留无法确认的数据并报告失败。
- 上游自动迁移返回 warning。`src/commands/doctor-config-preflight-startup.ts` 的 `completeStartupMigrationPreflight` 会将任意 `startupMigrationWarnings` 转为启动拒绝；例如 `state-migrations.plugin-state.ts` 读取旧插件状态失败、无法归档、目标内容冲突或导入容量不足。即使对应插件属于非核心功能，该迁移失败也不一定只影响插件。这些流程已有自动入口，但尚无一条统一的“非核心迁移失败就隔离继续”策略。
- 上游插件启动校验中未被隔离的错误。`doctor-config-preflight-plugin-verification.ts` 可以隔离具有安装路径的插件 smoke failure，但仍会阻断无法隔离的启用插件错误及部分升级收敛警告；`doctor-config-preflight-plugin-index.ts` 无法写入并复核插件索引时也会拒绝完成启动检查。

这些是源码确认的条件性拒绝路径，不是本次 QA 日志中新增复现的故障。模型凭据迁移的 `AuthProfileMigrationRequiredError` 在正常冷启动中由 `secrets/runtime.ts` 隔离为 degraded owner，IM 配对界面的旧接口则影响对应操作；它们可以按功能问题单独排期。现阶段接受非核心功能异常，不等于上游已经会隔离所有非核心迁移异常。

## 已确认的后续项

### IM 配对界面仍访问旧 JSON

`src/main/im/imPairingStore.ts` 的读取、批准和撤销仍操作 `credentials/*-pairing.json` / `*-allowFrom.json`，由 `src/main/main.ts` 的 IM IPC 调用。上游 `src/pairing/pairing-store-sqlite.ts` 已只访问 SQLite。

需要让 LobsterAI 的持续读写走上游配对 API/owner。否则可能出现新请求在界面不可见，或界面审批没有更新网关实际使用的允许名单。单次迁移不能替代接口适配。本次完成源码核对，未做真实 IM 账号端到端验收。

### 模型凭据迁移

需单独复用上游凭据迁移 owner，覆盖旧 auth profiles 和 OAuth；不能为避开错误清空凭据或给所有 agent 统一覆盖认证。上游当前通常隔离失败的 secret owner，允许 Gateway 带 degraded 状态启动，因此它与本次设备身份 fatal 应分别记录。验收要包含对应模型的真实最小请求。

### 失效的执行审批旧路径写入

`openclawConfigSync.ts` 的 `ensureExecApprovalDefaults` 仍写 `getBaseDir()/.openclaw/exec-approvals.json`；运行时优先 `OPENCLAW_STATE_DIR`，实际旧来源是 `getBaseDir()/state/exec-approvals.json`。这是无效旧旁路，不是每次都会重新制造本次 gate 对应文件。后续以配置/RPC 契约验证审批默认值后清理；不能把未使用路径擅自当成新的迁移来源。

## 可重复的验收

先构建使用相同固定版本与补丁的 runtime，再构建专用入口：

```text
node scripts/bundle-openclaw-startup-migration.cjs <runtime-dir> <patched-openclaw-source>
```

设置 `OPENCLAW_STARTUP_MIGRATION_RUNTIME` 为该 runtime 的绝对路径后运行：

```text
npm test -- openclawStartupStateMigration
```

额外设置 `OPENCLAW_STARTUP_MIGRATION_GATEWAY=1` 启用真实 Gateway 顺序/重启验收。测试只生成隔离数据与合成密钥，不访问 QA 的身份私钥或当前应用状态。

- 无 cron/session/workspace 旧数据时，单独身份与身份+凭据仍迁移。
- 原设备 ID、密钥、token、审批策略保留；配置字节不变；重启无重复导入。
- `.doctor-importing` 中断恢复；`.native-importing` 保留给原 owner 并提示恢复原生应用导入。
- 冲突或无效来源保留；同一轮报告多个阻塞点。
- 先运行 `memory index` 写入 state checkpoint，再执行专用迁移并启动 Gateway。
- Gateway `/startupz` 成功后，调用 `config.get`、`agents.list`、`exec.approvals.get`，再停止、重新检查、重启并复验。

后续每次升级固定版本时，都应对照上游 migration plan 和新 gate 更新这张覆盖表，并增加相应功能测试。仅检查端口、仅运行一个空白 state，或仅看到 session Doctor 成功，都不足以证明升级完整。

## 本地验证结果（2026-09-10）

- 从 `feat/openclaw-v2026.8.1` 的 `8aa557991c6ebe79b8725066df7a8427e0e8d3a2` 创建 `fix/openclaw-startup-state-migrations`。
- 启动迁移、会话、cron、网关、内存、配置同步回归：251 项通过；真实 Gateway 用例在该轮默认跳过，已单独启用并通过。
- 运行时打包与裁剪回归：9 项通过。
- 真实 Gateway 集成：确认 memory CLI 写入 state checkpoint 后旧身份仍存在；专用迁移后，两次启动的 `/startupz`、`config.get`、`agents.list`、`exec.approvals.get` 全部通过，设备 ID 保持不变。这不等于已证明现场 Mac 的 checkpoint 内容。
- 用编译后的主进程 adapter、实际 Electron 自带 Node 和本地 `vendor/openclaw-runtime/current` 验证：三类设备/审批来源迁移成功，密钥、token、策略和配置均保留；第二次执行报告零来源并跳过。
- `npm run compile:electron`、所有修改 TypeScript 文件的 CI 规则 ESLint、`git diff --check` 通过。
- 独立源码审阅未发现必须修正的剩余生产问题；未触碰真实用户状态，未做 Mac 安装包或真实 IM/模型 OAuth 的端到端验收。
