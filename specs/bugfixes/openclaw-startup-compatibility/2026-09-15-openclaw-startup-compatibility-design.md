# OpenClaw 升级后网关启动失败专项修复设计文档

## 1. 概述

初始基线：远端 `release/2026.9.15`，提交 `fe96376e3a2662ceb5d27d0531822d44a2bd2d3f`；实现分支 `fix/openclaw-startup-compat-recovery`。创建 PR 前同步到该 release 的 `b17e821097618e38b681f4bb58d5d851e9d6e3c7`，保留新合入的 xAI 凭据 helper，与本次兼容 helper 分别生成独立入口。LobsterAI 2026.9.14，固定 OpenClaw v2026.8.1。

### 1.1 问题

现场为 macOS arm64，2026.9.4 升级至 2026.9.14 后无法启动 AI 网关。[962b61 日志包](https://ydhardwarecommon.nosdn.127.net/962b61bbb6331763195ebe090f920ab3.zip)记录了两个先后发生的阻断：

1. 启动前的 session doctor 拒绝旧字段 `plugins.bundledDiscovery`。
2. 一键修复重建配置后，shared-state 数据库报 `column definitions differ for current_conversation_bindings`，doctor 退出 code 1，尚未 fork 网关。数据库相对路径为 `openclaw/state/state/openclaw.sqlite`，不是应用主库 `lobsterai.sqlite`。

08:49–08:53 共 17 次迁移失败（4 次配置错误、13 次数据库错误），9 次一键修复未恢复。截图中的微信重复插件和 acpx 未安装是 warning，错误摘要错误地优先选中了它们。

### 1.2 根因及证据边界

- 配置同步保留旧 `plugins` 字段；8.1 已把 bundled discovery 模式迁到 SQLite 机器状态，原 JSON 字段不再合法。
- session doctor 失败时启动直接结束；原一键修复只备份并重建配置，未修复状态库。
- doctor 摘要没有解析结构化 `cli_error.message` 和 `[openclaw] Reason:`，也没有排除实际的 `Config warnings:` 前缀。
- 数据库错误定位到了表，但日志没有现场 DDL 或数据库。标准 schema 1→15 的升级可成功；人工构造“schema 15 仍残留旧 target 列，加非空历史会话”可以复现同文案失败。**人工样例不是用户实际表结构；异常结构的形成原因尚未确认。**

因此，数据库写入范围仅包含下面明确列举并验证过的历史结构。未知差异保留数据并报告原因；不能宣称已经验证这位用户的实际数据恢复。

## 2. 用户场景

| 场景 | 预期行为 |
| --- | --- |
| 全新安装、已有健康状态 | 沿用正常启动，没有新增查库、完整性扫描或 helper 子进程 |
| 旧配置带有 bundledDiscovery | 读取已有配置时命中字段，按需保存机器状态，再移除旧字段 |
| 旧字段迁移碰到本次表结构异常 | 保留旧字段；专项恢复成功后重试配置迁移 |
| session doctor 或 gateway 首次报告本次异常 | 按明确失败进入恢复，每次启动请求最多尝试一次，成功后重新走启动 |
| 用户已重建配置，旧字段已消失 | 仍可凭本次数据库错误触发恢复 |
| 用户点击一键修复 | 保留专项迁移所需配置来源，复用启动恢复；其他错误保留原配置重建路径 |

## 3. 功能需求

1. 正常启动不新增数据库检查。配置判断复用 `ensureConfigFile()` 已有 JSON 读取，仅增加对象字段判断。
2. 只迁移 `plugins.bundledDiscovery`，接受固定版本的 `compat` / `allowlist`；SQLite 已有有效值优先。
3. 数据库恢复只接受应用自己的 shared-state 路径与本次 binding 表列定义错误。错误文本只选择处理分支，不能单独授权 SQL 修改。
4. 每次启动请求包含其自动重试在内，最多一次数据库恢复；用户显式重试可开启新请求。停止请求必须阻止恢复后再启动网关。
5. 有一致性备份和事务校验，不删除状态库、历史会话、凭据或工作区，不调整 schema 版本以绕过校验。
6. 弹窗显示真实阻断原因；修复提示覆盖配置与状态两种对象，中英文同步。

## 4. 实现方案及考量

### 4.1 触发点

不采用每次启动的统一数据库预检，也不新增升级台账或后台巡检。

`openclawEngineManager.ensureConfigFile()` 在原有 JSON 读取中返回是否存在旧字段。在 runtime 和 env 就绪、cron/session doctor 之前，仅命中时调用独立的 `openclaw-startup-compat.mjs migrate-config`。

数据库恢复接入现有 `startGatewayUntilSettled()` 失败分支。只有状态为 error、路径与表名匹配、应用管理的网关进程已结束，才调用 `repair-bindings`。恢复预算存在当前启动请求的局部变量中，不随内部重试清零。gateway 子进程的同类错误走相同分支，抑制原先无效的普通崩溃重试。

辅助程序独立打包，健康用户仍只使用原来的 startup migration bundle。没有整体移动设备、凭据、工作区等迁移。

### 4.2 配置兼容

在已有 stopped-gateway 维护锁下：原始配置只读解析 → 原文备份 → 固定版本 `importConfigMachineState()` 仅导入该项 → 读取并验证 canonical 值 → 使用既有 config IO 的快照与并发控制移除 JSON 旧字段。

先落库后删来源；中断后允许安全重试，已有机器状态优先。配置被其他写入者修改或后续校验失败时，不删除旧字段。后续 config sync 从已迁移文件读取，自然不会带回该字段，无需将该值盲目加入丢弃名单。

### 4.3 数据库恢复的允许范围

只支持固定 runtime 2026.8.1，`user_version = 15` 且 `schema_meta.primary` 为 global/15。允许的差异为：

- `target_agent_id TEXT NOT NULL`，无默认值或历史默认值 `'main'`；
- `target_session_id TEXT`，无默认值；
- 上述退役列的一项或两项残留；其余列、约束、表选项和索引必须匹配固定版本允许的结构；target 索引只能为当前定义或 2026.6.1 的定义。

从固定源码打包 canonical SQL 和结构校验器。先在内存数据库验证实际 DDL：只有去掉退役投影后可以满足当前契约的已知形状才允许继续。拒绝自定义索引、触发器、依赖视图、未知列或约束。

取得维护锁后，使用 Node SQLite backup 保存含 WAL 已提交数据的一致性快照到 `state/startup-recovery-backups/`。然后在 schema fence 和写事务中重新识别结构，移除确认的退役列并重建对应 target 索引。版本号保持 15。

对保留字段按主键流式计算带类型的摘要（含 bigint），验证主键、行数、全部保留值及 `record_json` 原文不变；同时运行固定版本完整 schema 校验、外键和完整性检查。失败回滚，不恢复整库覆盖后续写入。再次处理健康状态返回 skipped，不重复备份或写入。

这里修复的是已经识别的历史投影残留，不重新实现 OpenClaw 的通用版本迁移。正常旧库升级仍由原来的 owner 完成。

### 4.4 OpenClaw patch 的取舍

该版本已有 `importConfigMachineState()` 和 `repairOpenClawStateDatabaseSchema()`。前者可以直接复用。后者仍依据 schema 版本决定执行退役列迁移。已直接在人工复现库调用后者，结果为 `changes: []`，warnings 仍是同一 binding 列定义错误；现有 API 不覆盖该样例。

本次采用 LobsterAI 按失败触发的数据兼容入口，严格限制已验证结构，复用上游锁、机器状态 owner 和 schema 校验器。**没有新增或修改 OpenClaw patch**，也没有伪造旧版本参数强行调用旧迁移。helper 必须随当前 runtime 重新打包；开发环境不能只替换 Electron JS 而继续使用缺少 helper 的旧包。

若现场实际差异超出上述范围，必须先补充事实与数据样例再调整恢复规则；不能放宽通用 schema 校验来“让启动通过”。

### 4.5 一键修复和错误展示

已有兼容失败码或配置仍带旧字段时，一键修复保留原配置，再执行正常 bootstrap；对应 helper 负责所需备份。避免现有 rename 备份先移走待迁移值。其他配置问题仍走原配置重建流程。

doctor 原始结构化错误优先于 warning 和日志 fallback；gateway 最近输出同样提取本次根因，并标记共享错误码。完整诊断仍留在日志中。

### 4.6 涉及文件

- `src/main/libs/openclawStartupCompatibility.ts`：识别旧字段、解析实际错误、按需执行 helper。
- `scripts/openclaw-startup-compat.mjs`：维护锁、原始配置备份和机器状态迁移编排。
- `scripts/openclaw-binding-schema-recovery.mjs`：明确历史结构识别、一致性备份及事务恢复。
- `scripts/bundle-openclaw-startup-migration.cjs`：打包独立入口及固定上游模块。
- `openclawEngineManager.ts`、`main.ts`、`openclawGatewayRepair.ts`：少量启动失败和一键修复分支。
- `openclawSessionLegacyMigration.ts`、共享常量、renderer i18n：原因摘要、失败码及提示。
- 对应 Vitest 单元测试及 `tests/openclawStartupCompatibility.integration.test.ts`。

## 5. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| 旧字段非法或已有机器状态非法 | 保留来源，显示具体错误 |
| 用户主动取消/停止 | 等当前 helper 关闭，停止流程不启动替代网关 |
| 另一 gateway/维护命令占用 | 维护锁拒绝，当前启动结束，不并发改库 |
| 未知 schema、缺表、较高版本、元数据矛盾 | 拒绝恢复，保留原数据库 |
| 备份失败 | 不进入修改事务 |
| 其他表损坏或恢复后数据不一致 | 回滚当前事务，保留备份和诊断 |
| 修复后 doctor 仍失败 | 同一请求不再自动修表，展示新原因 |
| 微信/acpx 等插件 warning | 保留日志，不触发专项 SQL 恢复 |

## 6. 验收标准和验证记录

- 健康启动不新增 helper 调用；旧字段成功迁移后不再次执行。
- 非空旧会话与 binding 数据恢复后保留，session doctor 完成，gateway readiness 成功。
- 每个启动请求最多一次恢复；失败、取消和未知结构有明确结果。
- 对触碰的 TS 文件执行 CI 等价 lint、相关 Vitest 与 Electron 编译。
- 使用重新打包的 helper 运行真实 SQLite 集成验证，不以 mock 替代备份和数据校验。

验证在 Windows、Node 24.15.0 上进行，使用独立的 OpenClaw v2026.8.1 源码工作区并应用 release 已有 33 个 patch，再生成 helper。

| 验证 | 结果 |
| --- | --- |
| 配置同步、doctor、恢复入口、进程监督等相关 Vitest | 主回归 238 项通过、22 项跳过，其中包含 12 项实际 SQLite 集成测试。跳过的是未配置的既有运行时恢复测试及配置同步中的可选外部集成 |
| 最终失败分类与界面增量验证 | 29 项通过；包括将非致命 health-state warning 与其他实际错误区分，防止误触发修表 |
| 创建 PR 前同步 release 后复验 | 三个启动 helper 均重新打包成功；专项回归（含界面和 12 项实际 SQLite 集成）242 项通过、22 项既有可选测试跳过；xAI 凭据入口集成测试另外 5 项通过。变更文件 lint 与 Electron 编译再次通过 |
| SQLite 集成 | WAL 已提交数据包含在备份中；保留字段及大整数原值一致；重复执行不写入；未知列、约束、唯一索引、触发器、更高版本、备份失败均拒绝；其他表异常导致事务回滚 |
| 标准 schema 1 + 旧字段 + 非空历史会话 | 旧字段迁移成功，doctor code 0，gateway `/startupz` 为 `started`，正常退出 code 0 |
| schema 15 残留旧列 + 非空历史会话 | 修复前 doctor code 1；专项恢复后 doctor code 0，旧 JSON 会话完成归档，生产模式 gateway `/startupz` 为 `started`，正常退出 code 0 |
| 历史消息保留 | 升级和恢复两个样例的 agent SQLite `transcript_events` 中均能读取原测试用户消息，完整性检查为 ok |
| 同目录运行中的 gateway | 使用生产模式（去掉测试环境下的 gateway 免锁行为）启动后，helper 修复请求因维护锁被拒绝，无备份和写入 |
| TS/TSX 变更文件 lint | CI 等价参数下 0 error、0 warning；新脚本语法检查及 diff 空白检查通过 |
| Electron 编译及 renderer build | `npm run compile:electron`、`npm run build` 均通过；build 有现有依赖的 eval、chunk 体积、动态/静态混合 import、Browserslist 数据过旧等提示 |

集成测试需要显式设置 `OPENCLAW_STARTUP_COMPAT_RUNTIME` 为重新打包 helper 的 runtime 目录，`OPENCLAW_STARTUP_COMPAT_SOURCE` 为对应固定版本源码目录。先运行 `node scripts/bundle-openclaw-startup-migration.cjs <runtime目录> <OpenClaw源码目录>`，再运行 `npm test -- openclawStartupCompatibility`。默认 `npm test` 中没有配置这些目录时，该实际运行时集成组会明确跳过。

本次未运行 macOS 图形界面/安装包验证，未操作现场用户的数据。

**发布前仍需**：用这位用户的只读 DDL 核对允许结构，并在 macOS arm64 安装包上验证升级和一键修复。现有日志包未包含这些输入，本次 Windows 人工样例不能代替该现场验证。

现场只需先获取以下只读输出，不需要提供聊天或凭据内容：

```sql
PRAGMA user_version;
SELECT meta_key, role, schema_version, app_version FROM schema_meta;
PRAGMA table_xinfo(current_conversation_bindings);
SELECT type, name, sql FROM sqlite_schema
WHERE tbl_name = 'current_conversation_bindings';
```
