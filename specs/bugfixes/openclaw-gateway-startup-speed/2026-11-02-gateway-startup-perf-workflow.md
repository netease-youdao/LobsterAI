# OpenClaw 网关启动性能：验证与优化流程

## 1. 背景

网关启动慢，但"慢"有三种来源，混在一起很难判断某次优化是否有效：

- 网关进程本身（模块加载、OpenClaw 自己的状态迁移、插件加载、渠道启动）；
- LobsterAI 侧在 fork 之前的准备（startup prep helpers、迁移）；
- 重启时旧网关的关闭耗时（超过 6s 宽限会被 SIGKILL）。

在真实 App 里直接测速会受 IM 渠道、定时任务、模型调用等外部副作用干扰，也可能影响用户数据。本流程把"测量"和"真实环境"分开。

## 2. 工具

| 命令 | 作用 | 副作用 |
|------|------|--------|
| `npm run perf:openclaw:logs -- --days 3` | 解析 `~/Library/Logs/LobsterAI/main-*.log`，列出每次真实启动的分阶段耗时、触发原因、prep 是否跳过、checkpoint 命中情况、关闭耗时与 SIGKILL 次数 | 只读日志，App 运行中也可用 |
| `npm run perf:openclaw:bench -- [选项]` | 在隔离沙箱中用真实状态的克隆反复启动网关，计时 + 功能检查 + A/B 对比 | 见 §3，仅 macOS |

共享解析逻辑在 `scripts/openclaw-startup-timeline.cjs`，测试见 `tests/openclaw-startup-timeline.test.ts`。

### 2.1 分阶段定义

| 阶段 | 起点 → 终点 | 主要内容 |
|------|-------------|----------|
| boot | fork → `loading configuration` | 模块加载、OpenClaw 状态迁移（checkpoint 未命中时） |
| config | → `starting HTTP server` | 配置/认证解析、插件自动启用、运行时状态准备（首次写 agent 库） |
| plugins | → `starting channels and sidecars` | 插件注册表加载 |
| sidecars | → `[gateway] ready` | 渠道、sidecar、gateway_start hooks |
| detect | → `/startupz` 返回 started | LobsterAI 探测延迟 |
| total | fork → `/startupz` started | 用户可感知的网关就绪时间 |

## 3. 隔离保证（bench）

- 状态：用 APFS clonefile 克隆 `~/Library/Application Support/LobsterAI/openclaw` 到临时目录，配置中的路径改写为克隆路径，第三方插件目录指向被测运行时。插件、渠道、MCP、agent、定时任务配置与真实环境一致。
- 写入：网关在 `sandbox-exec` 中运行，禁止写入 `$HOME` 下任何路径（克隆目录在系统临时目录）。被拦截的写入会在报告中列出。
- 网络：禁止除 loopback 外的所有出站连接，并清除代理环境变量。IM 渠道、模型供应商、远程 MCP、git 同步都无法触达外部，因此不会收发消息、不会消耗额度。
- 凭据：不读取任何真实凭据，`${VAR}` 占位符注入假值。
- 端口与 token 每个运行时固定（与 App 持久化行为一致）；它们参与有效配置指纹，随机化会导致 checkpoint 每次都未命中。
- 事后校验：结束时扫描真实状态目录，测速期间有任何文件被修改即判失败（LobsterAI 正在运行时只提示，因为它自己会写）。没有提供放开网络的开关：克隆中带有真实渠道 token（如微信），不受限的网关会轮询用户的 IM 账号并可能回复消息。

注意：插件安装记录以绝对路径存放在数据库中，克隆网关会以只读方式加载真实目录下用 npm 安装的插件（如 `state/npm/projects/...openclaw-weixin`）。这类插件的 `openclaw` peer link 指向安装它的运行时，所以对比其他运行时时，会出现 `missing-openclaw-peer-link` 的 doctor 警告；这是测速环境的产物，不是被测运行时的回归。

不能覆盖的部分：真实网络下的渠道连接耗时、微信长轮询的关闭行为（离线时轮询立即失败），这些用 `perf:openclaw:logs` 观察真实日志。

## 4. 场景

| 选项 | 模拟 |
|------|------|
| （默认） | 普通重启：第 1 次为克隆后首启（迁移必跑），第 2..N 次为暖重启 |
| `--config-change` | 配置同步触发的重启：每次启动前改一个有效配置值 |
| `--cold-cache` | 开机或长时间闲置后的首次启动：每次启动前原地重新克隆所有 SQLite 文件，内容不变但页缓存失效 |
| `--cpu-prof` | 记录 V8 CPU profile，报告 boot 阶段热点（自动选择最忙的进程） |
| `--runtime label=path`（可多次） | A/B 对比，第一个为基线 |

退出码：0 表示无功能差异；1 表示有运行未就绪、健康检查失败，或与基线相比插件列表、`channels.status`、`tools.catalog`、`skills.status`、`cron.status` 摘要不一致；2 表示脚本自身错误。可直接作为优化的回归门禁。

## 5. 本次测量结论（2026-11-02，本机，main agent 库 305MB）

真实日志（5 天，32 次就绪启动）：boot 中位数 5.2s，total 中位数 12.3s；checkpoint 未命中 20/32；32 次关闭中 17 次超过 6s 被 SIGKILL。

bench（dev 运行时，单位秒）：

| 场景 | boot | total |
|------|------|-------|
| 普通重启，checkpoint 命中 | 0.8–1.1 | 3.0–3.4 |
| 配置变更重启，暖缓存 | 1.9–2.4 | 4.0–4.7 |
| 普通重启，冷缓存 | 1.3–1.4 | 11.5–11.8 |
| 配置变更重启，冷缓存 | 10.4–10.5 | 12.5–12.6 |

A/B：已安装的 2026.10.30 运行时与本分支 dev 运行时差异在噪声内（暖 total -0.24s），功能检查无差异。本分支的两处提速都不在网关的启动路径上：prep 跳过发生在 LobsterAI fork 之前；微信长轮询中止补丁已在 dev 运行时中，但它只缩短关闭耗时，离线沙箱里轮询会立即失败，体现不出来。

根因（CPU profile 确认）：冷启动的主要耗时是对 agent 数据库的全量 `PRAGMA integrity_check`，冷缓存下 6–8s，暖缓存约 0.25s。它在两处执行：

1. 状态迁移重跑时（checkpoint 未命中）：`autoMigrateLegacyState → migrateHistoricalTranscriptDirectives → migrateOpenClawAgentDatabaseForMaintenance → assertAgentDatabaseIntegrityBeforeMutation`。即使迁移游标已是 `complete`，也会先做维护检查；
2. 每次启动的首次写：`runActiveStoreWriter → openOpenClawAgentDatabase → assertAgentDatabaseIntegrityBeforeMutation`。

两处都检查同一个库，耗时随库大小增长。

### 5.1 完整性检查缓存补丁的效果

`openclaw-agent-db-integrity-stamp.patch`，冷缓存，每个运行时 4 次，测试期间 LobsterAI 在运行（数字含噪声）：

| 场景 | 基线 total | 补丁 total | 差值 |
|------|-----------|-----------|------|
| 普通重启，checkpoint 命中（暖重启中位数） | 12.43s | 6.80s | -5.6s |
| 首次启动，状态迁移重跑 | 15.52s | 13.61s | -1.9s（迁移阶段验证后写的 stamp 被同一次启动的运行时打开直接复用） |

每次启动有 11 个 agent 库命中 stamp。插件列表、`channels.status`、`tools.catalog`（99 个工具）、`skills.status`、`cron.status` 两边一致，门禁退出码 0。补丁运行时的构建方式：在独立 worktree 打上全部补丁并 `pnpm build`，再把 `dist` 换进当前运行时的克隆（保留原有扩展目录及其依赖）。没有触碰 `vendor/openclaw-runtime/current`。

补丁后冷缓存下的下一批热点（CPU profile，config 阶段约 4.4s）都是每次启动都跑的会话全表扫描：
- `migrateManagedWorktreeCanonicalWorkspaces → listLegacyWorktreeSessionEntries`，约 1.9s；
- `deleteOrphanedTranscriptIndexRowsInTransaction`，约 1.4s；
- `cleanupPluginHostSessionStore → listSqliteSessionEntriesFromDatabase`（含 `structuredClone`），约 1.0s。

### 5.2 已验证无效：去掉单个会话扫描（未发布）

`2026-11-02-startup-session-scans.rejected.patch`（本目录，未放入补丁目录）做了两件事：孤立索引清理改用 `NOT EXISTS` 索引探测；worktree 规范化迁移在完成后写入 `schema_meta` 标记，此后跳过。改动本身正确（等价性测试、标记测试通过），但 A/B 显示没有收益：

| 场景 | 仅 stamp | stamp + 扫描补丁 |
|------|---------|------------------|
| 冷缓存暖重启 total 中位数 | 6.42s | 6.26s（config -1.49s，sidecars +1.40s） |
| 暖缓存重启 total 中位数 | 2.81s | 2.85s |

原因：这些扫描在冷缓存下是 I/O 受限，不是 CPU 受限。去掉第一个读者后，下一个读同一批页的步骤（如 `createWorkerPlacementSessionEvidenceResolver → readSessionEntryKeys`）付同样的冷读代价；孤立索引清理在冷缓存下的成本是读 FTS 内容表本身，改写执行计划无法避免。暖缓存下这些扫描本来就便宜。教训：用 `sqlite3` CLI 做"暖"测时要看 user time，`real` 高而 `user` 接近 0 说明仍在等 I/O。

### 5.3 已实现：全量历史扫描整体延后到网关空闲（`openclaw-startup-defer-history-scans.patch`）

把就绪不依赖的全量历史读取一起挪到就绪之后：worktree 规范化、孤立索引清理（仅在无过期投影时）、首次 worker placement 会话回收、首次媒体维护（含出站媒体 GC）。只"放到就绪后立即执行"不够：同步 SQLite 会阻塞事件循环，`/startupz` 探测要等 3.4s；因此释放后先等 3s，再等网关 1s 无活跃请求，每个任务前都重新等待。

| 冷缓存场景 | 仅 stamp | + 延后补丁 |
|------|---------|-----------|
| 正常重启 ready 中位数 | 6.38s | 2.96s |
| 状态迁移重跑的首启 | 13.68s | 12.68s |

`--hold 20000` 下所有延后任务在就绪后约 9s 内执行完；就绪后最长一次事件循环卡顿约 1.1s（孤立索引清理）。网关在就绪后立刻被关闭时，关闭阶段会冷打开各 agent 库，关闭耗时 1.7s → 3.5s（仍低于 6s 强杀线；正常使用中延后任务早已执行，不受影响）。测速脚本新增 `--hold <ms>` 和"就绪后最慢探测"指标用于验证这一类改动。

结论：冷启动剩余成本的根因是热库里的会话数据量（主库 305MB，其中 `transcript_events` 187MB，95% 属于 30 天前的会话）。逐个去掉读者只会转移成本，有效的方向是减少热库数据量（保留期或归档到独立库），需要产品决策。

## 6. 自动化优化循环

1. **定位**：`npm run perf:openclaw:logs -- --days 5`，看哪个阶段、哪类原因（restart:config-sync / 首启）最慢，以及 SIGKILL 次数。
2. **复现**：`npm run perf:openclaw:bench -- --runs 4 --cold-cache --cpu-prof --skip-health`（按需加 `--config-change`），确认与真实日志同量级，读 boot 热点。需要 boot 以外阶段的热点时，用 `--keep` 保留 profile 后自行聚合调用链。
3. **修改**：按 AGENTS.md 的补丁策略，优先 LobsterAI 侧；问题在 OpenClaw 内部时做版本化补丁，然后 `npm run openclaw:patch` 并重建运行时（`npm run openclaw:runtime:host`）。
4. **验证**：保留旧运行时目录做基线，`npm run perf:openclaw:bench -- --runtime base=<旧> --runtime dev=vendor/openclaw-runtime/current --runs 5 --cold-cache`，要求退出码 0、目标阶段下降，并检查报告中"only dev printed"的新错误签名。
5. **回归**：`npm test`；涉及主进程时再跑 `npm run compile:electron`；最后用 `npm run electron:dev` 实机启动一次，再用 `perf:openclaw:logs -- --days 1` 确认真实日志中的变化。

## 7. 下一步优化候选

| 候选 | 预期收益 | 风险 |
|------|----------|------|
| OpenClaw 补丁：`migrateAgentDatabase` 先只读查迁移游标，`complete` 时跳过维护和完整性检查 | 配置变更重启冷缓存时省掉一次全库检查（约 6–8s 的前半） | 维护路径里的 schema 补齐改由首次打开时完成，需要确认首次打开同样会补齐 |
| **已实现**：`openclaw-agent-db-integrity-stamp.patch`。完整性检查结果按文件身份（dev/ino/birth/ctime/mtime/size）缓存，干净关闭时记录，下次打开未变化则跳过（WAL 模式下头部 change counter 不可靠，故未采用）。细节见 `scripts/patches/v2026.8.1/README.md` | 冷启动省掉 6–8s，与库大小无关 | 运行中崩溃/SIGKILL、外部写入或 chmod、文件替换、残留 WAL、升级与迁移都会回落到全量检查；后台每日校验不变 |
| `integrity_check` 改为 `quick_check` | 有限，冷 I/O 仍需全量读页 | 不再校验索引与表的一致性 |
| LobsterAI 侧减少配置同步触发的重启（尤其启动阶段的 media-entitlement / server-models） | 每避免一次就少一次关闭和启动（关闭被 SIGKILL 时约 6s + 启动 4–12s） | 需逐项确认是否支持热更新 |
