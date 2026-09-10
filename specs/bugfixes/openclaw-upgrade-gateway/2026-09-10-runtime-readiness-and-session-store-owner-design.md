# OpenClaw 运行期启动页闪回与会话归属配置反复写入修复设计文档

## 1. 概述

### 1.1 问题与背景

LobsterAI 升级到 OpenClaw `v2026.8.1` 后，已陆续适配 Agent ownership、旧会话迁移、插件配置和网关恢复。此前修复解决了部分启动失败，但 QA 在 2026-09-10 仍反馈：新建对话并聚焦输入框后出现引擎重启页，几秒后消失；继续输入再次出现；切换模型时又进入重启页。

本次排查使用 QA 提供的当日日志，源码分析基线为 `feat/openclaw-v2026.8.1` 的 `d3a691531`。日志没有可确认安装包对应提交的构建哈希，因此源码结论针对该基线，并以日志中的同名调用行为交叉验证。实现提交前已更新到目标分支 `2ba29cecc`。以下时间均为 UTC+8。

需要区分三个已经分开处理的问题：

- 9 月 8 日的 ownership 适配改为输出显式 `agents.entries`，并补齐主 Agent 的兼容归属。当时无条件补入的 `agents.defaults.sessionStore.agentId=main` 是本次配置反复变化的来源。
- [LobsterAI PR #2635](https://github.com/netease-youdao/LobsterAI/pull/2635) 增加配置 hash 冲突退避和延迟重启前的重新投递。在本次日志中，该逻辑已经成功取消了一次兜底重启，但不负责运行期 Starting 状态，也不解决配置字段反复补写。
- [LobsterAI PR #2642](https://github.com/netease-youdao/LobsterAI/pull/2642) 修复旧会话迁移被重复 transcript header、可恢复告警阻断的问题。本次以其为最终基线，补充迁移前后 owner 的生成规则，不替代其迁移判断。

QA 日志中的关键事实：

| 时间 | 证据 | 判断 |
| --- | --- | --- |
| 11:20:21–27 | `skills-changed` 配置同步进入已有进程检查，`currentPhase=running`，启动探针约 1.5 秒超时，随后 `live=true`、`ready=true`；最终 `config.set` 成功且 `restartScheduled=false` | 第一次启动页来自原进程等待就绪，不是新进程启动 |
| 11:20:33–38 | 主 Agent 模型保存后再次发生 `ready=false → live=true → ready=true` | 切换模型触发配置同步，重复进入同一状态分支 |
| 11:20:48–11:23:17 | `config.get` 超时安排兜底；后续配置同步的就绪检查等待约 149 秒；定时器心跳迟到约 140 秒 | 网关存在真实响应延迟，不能仅通过隐藏页面宣称服务恢复 |
| 11:23:18–37 | 多次热加载仅涉及 `agents.defaults.sessionStore` | 存在与业务配置无关的重复写入 |
| 11:23:38 | 延迟兜底重新投递成功，记录 `mode=rpc`、`restartScheduled=false`、`NO RESTART` | 该兜底没有实际执行硬重启 |

11:20–11:24 没有进程退出、新进程创建或实际 `restartGateway` 记录。当天 10:00 左右确有一次重启，应与本次交互区分。输入控件日志没有记录每次操作的完整 action，不能断言每次聚焦或输入都直接触发了网关重启。

### 1.2 根因

**运行期探针失败被错误地表示为新一次启动。** 配置投递取得 Gateway RPC 客户端前会调用 `startGateway()`。已有进程的 `/startupz` 探针失败、但 liveness 成功时，旧实现无条件广播 Starting，等待循环又持续刷新 Starting 进度。界面收到该状态就展示全屏启动页，探针恢复后页面消失，即使始终是同一个进程。

liveness 包含 TCP 可连接的兜底，不能证明 HTTP 或 RPC 已可用。因此应保留实际就绪等待，只修正已经运行的进程被重新归类为 Starting 的行为。

**配置生成器与上游归属规范化规则冲突。** LobsterAI 默认不设置固定 `session.store`，使用按 Agent 存储的布局，却每次都生成 `agents.defaults.sessionStore={agentId: 'main'}`。上游写配置时将其视为从旧配置复制过来的兼容 owner，普通完整 `config.set` 又不携带 owner 路径的显式赋值语义，因此会移除此值。下次同步再次补入，形成“补字段 → 写入并下发 → 上游移除 → 再次判定变化”的循环。

该循环增加了文件写入、热加载和再次探测就绪的次数；现有日志和实验不能量化它对 149 秒等待的贡献。日志还显示事件循环压力，但没有 CPU profile 或阻塞调用栈。本次不将长时间卡顿全部归因于该字段，也不声称已解决其性能根因。

### 1.3 上游依据与适用边界

核查对象是官方 `v2026.8.1`，tag commit 为 `ea806575e6450e4d1efdfc72c19f04be982a1b9b`。该字段仍有兼容性用途，没有查到官方建议所有集成都统一删除它。

| 上游资料 | 与本次修复相关的规则 |
| --- | --- |
| [Agent 配置文档](https://github.com/openclaw/openclaw/blob/v2026.8.1/docs/gateway/config-agents.md#L630)、[配置字段帮助](https://github.com/openclaw/openclaw/blob/v2026.8.1/src/config/schema.help.core.ts#L362) | `systemAgent`、`authInheritance` 与 `sessionStore` 分别负责不同归属；`sessionStore` 用于旧 main 会话及固定存储中未限定 Agent 的行，不能用 system agent 代替 |
| [Doctor 文档](https://github.com/openclaw/openclaw/blob/v2026.8.1/docs/gateway/doctor.md#L421) | 旧 JSON/JSONL 由显式 Doctor 流程迁移，未迁移时网关拒绝就绪；已移除 main 的显式 roster 可通过兼容 owner 确定旧数据归属，对按 Agent 和固定存储均有效 |
| [写配置归属处理](https://github.com/openclaw/openclaw/blob/v2026.8.1/src/config/io.session-store-owner.ts) | 兼容 owner 绑定同一个物理固定存储；明确赋值 owner 路径可以建立目的存储归属，复制整份配置不等于该显式赋值 |
| [PR #123235](https://github.com/openclaw/openclaw/pull/123235) | 固定存储迁移使用持久化 owner，避免其它 Agent 使未限定行被误判为歧义；owner 可以与 system agent 不同。已包含于固定 tag |
| [PR #123887](https://github.com/openclaw/openclaw/pull/123887) | 修复按 Agent 存储下旧 main 迁移不接受显式 owner 的问题，并更新文档和测试。已包含于固定 tag |
| [Issue #133889](https://github.com/openclaw/openclaw/issues/133889)、[PR #133920](https://github.com/openclaw/openclaw/pull/133920) | 切换存储时，父级配置重放错误地带回已清除的旧 owner；修复保留同存储和显式 owner 的规则。PR 于 2026-08-31 合并，尚未包含于固定 tag |

包含关系使用官方 Git 历史上的 `git merge-base --is-ancestor <mergeSHA> v2026.8.1` 核实。三个 PR 的 merge SHA 分别为 `f66a2c6a294414a22e4cba3a205cdf27a5eb63ee`、`722e1ff48ea99c3b03d45cdeddbfef88b1aeb111` 和 `ca6bb887b57b416113f5e73a99ec5a8b3b565060`。

#133920 与本次使用同一归属规则，但触发条件是切换存储及父级配置重放，不能据此认定是 QA 的相同根因，也不能认为单独移植它就能解决 LobsterAI 无条件补写字段的问题。本次没有新增 OpenClaw patch。

## 2. 用户场景

1. **已经运行时同步配置**：用户新建对话、切换默认模型或修改技能，网关进程存活但探针暂时超时。界面保持当前对话，配置调用继续等待，恢复就绪后完成下发。
2. **首次启动或真实重启**：进程尚未完成启动、崩溃恢复，或持续无响应后决定替换进程。仍展示启动进度，不提前放行 RPC。
3. **旧共享会话升级**：main 和 worker 共用旧 `state/sessions/sessions.json`，其中存在未标明 Agent 的记录。迁移前保留 owner，官方 Doctor 完整导入并归档后，普通配置不再自动补写。
4. **企业自定义存储**：企业配置使用固定存储或显式指定兼容 owner。最终合并结果保留其归属语义，不因普通配置的优化而丢失。

## 3. 功能需求

- FR-1：将进程启动生命周期与运行期暂时不可就绪区分开；同一个已运行进程的探针超时不重复展示启动页。
- FR-2：就绪检查仍约束调用方；保留原有超时、进程替换、崩溃恢复和配置投递兜底。
- FR-3：普通按 Agent 存储配置经过上游规范化后，重复同步不再仅因 sessionStore 产生变化。
- FR-4：旧共享迁移未完成时保留归属；不以 Doctor 单次退出码或曾经启动成功代替源文件归档事实。
- FR-5：固定存储保留原有兼容默认，企业显式 owner 优先；数据导入、归档和冲突处理仍交由官方 Doctor。

## 4. 实现方案

### 4.1 网关状态与等待

`OpenClawEngineManager.startGateway()` 在已有进程存活、探针未就绪的分支中，仅当当前状态不是 Running 时进入 Starting。`waitForGatewayReady()` 也仅在 Starting 状态刷新启动进度，避免等待循环重新打开启动页。

调用方仍等待 `/startupz`，沿用原有 300 秒等待上限。等待恢复后返回 Running；决定停止并替换旧进程时先设置 Starting。首次启动和原有退出监督逻辑继续生效。探针失败保留诊断信息，周期性轮询日志改为 debug 级别。

### 4.2 按需生成会话归属

新增小型策略模块 `openclawSessionStoreOwner.ts`，不扩展大型配置类的业务分支：

| 最终配置与磁盘状态 | 处理 |
| --- | --- |
| 策略输入已经显式包含 owner | 保留，包括企业为旧 main 迁移指定的 owner；无效显式值仍由上游校验，不静默替换 |
| 旧共享 `state/sessions/sessions.json` 仍存在 | 优先保留已有配置中的命名 owner，没有记录则延续 LobsterAI 原先的 main 默认 |
| 未指定 `session.store`，或使用含 `{agentId}` 的模板，且旧共享源已归档 | 不再自动补写 owner |
| 非空 `session.store` 不含 `{agentId}`，且未指定 owner | 保留 LobsterAI 原先的 main 兼容默认 |

完整配置生成读取既有迁移 owner，并在序列化前应用该策略；模型未加载时的最小配置路径同样补齐必要归属。最小配置原本会保留非模型配置，因此已有 owner 可先保留；后续完整同步或上游规范化移除后，不会在没有旧共享源的情况下再次补写。

企业配置可在普通同步之后覆盖 `session.store`，故 `mergeOpenClawConfigs()` 在合并后再次处理最终布局。显式企业配置优先，不能仅根据普通配置默认布局提前删除企业所需的 owner。这里延续 main 的默认是 LobsterAI 的兼容决策，不是替任意上游部署推断新存储的归属。

源文件检查只读。路径不存在才按没有旧共享源处理；权限等检查错误不会被吞掉并误判为迁移完成。策略不操作会话文件、不新建迁移标记，不改变普通会话的 Agent 路由或消息格式。

这与 #2642 的迁移结果处理相容：该修复允许满足完整归档证据等条件的已知告警继续启动，而本次 owner 是否还需补写取决于旧共享源是否仍在，不依赖 `code === 0`。只要仍有待迁移数据，就继续保留 owner 并沿用迁移失败保护。

### 4.3 为什么不直接删除字段

用固定运行包的实际 Doctor 导入器构造多 Agent 对照，得到以下结果：

| 旧数据布局 | 保留 owner | 无条件删除 owner |
| --- | --- | --- |
| 共享源内 main、worker 各一条明确归属记录，加一条 `voice:ambiguous` | 导入 3 条，旧源归档 | 仅导入 2 条，旧源保留 |
| main、worker 各自目录共 4 条记录 | 导入 4 条，旧源全部归档 | 导入 4 条，旧源全部归档 |

在 explicit 多 Agent roster 下，system agent 不会代替共享源中未限定行所需的兼容 owner。无条件删除会留下未完成导入的历史，LobsterAI 检查到旧存储残留后阻止启动。上游也有对应的[共享存储归属回归测试](https://github.com/openclaw/openclaw/blob/v2026.8.1/src/commands/doctor-session-sqlite.test.ts#L3015)。

因此，修复目标是停止不必要的补写，同时保留有实际兼容作用的归属，而不是把该字段当作无效配置全局清除。

### 4.4 其它方案取舍

| 方案 | 不采用的原因 |
| --- | --- |
| 继续无条件补写，或强制上游始终保留 | 不能消除生成器与上游规范化的冲突；也会把迁移兼容字段扩展为所有普通配置的固定默认 |
| 只在界面延迟显示/隐藏启动页 | 无法修正主进程状态语义，仍有重复配置写入；用固定延迟也不能区分真实重启 |
| 探针超时后直接视为可用 | TCP 存活不代表 RPC 可用，会绕过已有就绪门禁 |
| 只忽略配置比较中的 sessionStore | 不能明确解决字段何时应保留、何时应移除的问题，并可能漏掉真实迁移归属变更 |
| 本次直接移植 #133920 | 它修复更换存储时的写入重放，本次普通配置并未更换存储；当前有清晰的 LobsterAI 配置生成/企业合并入口，无需新增上游补丁 |

### 4.5 涉及文件

- `src/main/libs/openclawEngineManager.ts`：已有进程的状态转换和等待进度。
- `src/main/libs/openclawSessionStoreOwner.ts`：迁移与固定存储的 owner 策略。
- `src/main/libs/openclawConfigSync.ts`：完整/最小配置的策略接入。
- `src/main/libs/enterpriseConfigSync.ts`：企业配置合并后的策略接入。
- 对应的 `openclawEngineManager.restart.test.ts`、`openclawSessionStoreOwner.test.ts`、`openclawConfigSync.runtime.test.ts`、`enterpriseConfigSync.test.ts`：状态、归属、同步稳定性和企业覆盖回归。

## 5. 边界情况

| 场景 | 处理与限制 |
| --- | --- |
| 首次启动、真实进程退出、明确替换旧进程 | 仍报告 Starting，并等待实际就绪 |
| Running 进程探针短暂失败 | 保持 Running 展示，调用方仍等待；不承诺等待期间请求已可成功 |
| 持续无响应直至原等待上限 | 进入原有替换流程；本次不移除恢复兜底 |
| Doctor 失败或仅部分迁移 | 旧共享源仍在时保留 owner，不删除源文件以绕过启动保护 |
| 原先按 Agent 目录保存的旧 JSON/JSONL | 沿用官方按目录归属的迁移，不新增共享归属推断 |
| 读取旧共享源状态出现权限错误 | 报错，避免将不可检查当作已迁移 |
| 企业显式 owner，包括按 Agent 存储下的迁移配置 | 尊重显式配置；本次同步稳定性保证针对 LobsterAI 自动补写的普通默认，不擅自清理用户兼容声明 |
| 网关长时间事件循环阻塞、停机慢 | 保留为独立待定位问题，不能用启动页消失或本次冷启动耗时推断性能问题已解决 |

## 6. 验收标准

### 6.1 自动回归与本地检查

覆盖以下行为：短暂未就绪时无 Starting 事件；首次启动仍显示进度；持续无响应决定替换时进入 Starting；共享迁移未完成时保留 owner；归档后停止补写且重复同步稳定；模型未加载、固定存储、企业显式 owner 均保留必要归属。

提交前在更新后的目标基线上执行：

```sh
node node_modules/vitest/vitest.mjs run src/main/libs/openclawEngineManager.test.ts src/main/libs/openclawEngineManager.restart.test.ts src/main/libs/openclawConfigSync.runtime.test.ts src/main/libs/openclawConfigDelivery.test.ts src/main/libs/openclawSessionLegacyMigration.test.ts src/main/libs/openclawWorkspaceStateMigration.test.ts src/main/libs/openclawSessionStoreOwner.test.ts src/main/libs/enterpriseConfigSync.test.ts --reporter=dot
node node_modules/eslint/bin/eslint.js --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/openclawEngineManager.ts src/main/libs/openclawEngineManager.restart.test.ts src/main/libs/openclawConfigSync.ts src/main/libs/openclawConfigSync.runtime.test.ts src/main/libs/openclawSessionStoreOwner.ts src/main/libs/openclawSessionStoreOwner.test.ts src/main/libs/enterpriseConfigSync.ts src/main/libs/enterpriseConfigSync.test.ts
npm --ignore-scripts run compile:electron
git diff --check
```

使用独立 worktree 的编译输出；跳过安装生命周期，避免重建与原工作区共享的原生依赖。更新到 `2ba29cecc` 后，8 个测试文件共 243 项，242 项通过，1 项完整运行包配置校验因企业微信插件缺少 `dist/index.js` 失败；该错误已在未修改基线复现。8 个修改/新增 TypeScript 文件的 lint、Electron 编译和差异空白检查通过。

### 6.2 真实 Doctor 与网关验证

在隔离 Windows 状态目录、loopback 端口和假模型凭据下，使用编译后的配置同步/迁移代码与固定版本运行包验证：

1. 生成 main、worker 和未限定归属记录组成的三条旧共享会话，迁移前配置包含 main owner。
2. 真实执行 `doctor --session-sqlite import --session-sqlite-all-agents --json`；三条记录及六个 transcript 事件完整导入，旧 store 归档。
3. 读取实际 SQLite，确认未限定记录仍归属 main，worker 保留自身历史，所有用户消息内容逐条匹配。
4. 真实网关启动后，通过 WebSocket `config.get/config.set` 规范化配置；随后技能、Agent、应用配置重复同步均为 `changed=false`。
5. 切换测试模型可热更新，PID 不变；挂起 `/startupz` 五秒时调用仍未返回、状态保持 Running，恢复响应后完成，期间无 Starting 事件。

以上功能断言在更新到 `2ba29cecc` 后再次通过，冷启动约 187 秒。本地完整运行包的企业微信插件缺少 `dist/index.js`，配置校验在未修改基线上也会失败，因此隔离验证排除了该可选插件，不能作为完整发行包或企业微信验收。

清理仍存在独立限制：网关收到 SIGINT 后超过现有六秒窗口，触发原有 SIGKILL；本轮在强制退出后的两秒观察窗口内也未收到退出事件，导致脚本以退出码 1 结束，随后已确认隔离子进程退出。功能断言通过不等于整个验证脚本或优雅停机通过；本次未修改进程停止逻辑。

未运行真实模型推理或完整 Electron 界面。隔离冷启动耗时受运行包和插件集合影响，本次不据此宣称性能提升。

### 6.3 QA 复测

1. 从旧版升级，分别使用共享旧存储和按 Agent 分目录的旧数据，检查迁移完成、归档保留、历史消息可读；重复启动不重复迁移。
2. 新建对话后聚焦并输入，穿插技能同步和主 Agent 默认模型切换。短暂探针超时不再反复展示启动页，实际配置成功后日志显示 RPC 投递完成。
3. 检查无业务变化时不再出现仅 sessionStore 引起的连续热加载；同服务商模型切换的成功热更新保持 PID 不变。
4. 验证首次启动、真实崩溃恢复和必须重启的配置变更仍展示进度；持续无响应仍保留失败/恢复路径。
5. 企业固定存储与显式非 main owner 场景确认归属不变；完整运行包测试前补齐缺失插件。若仍有长卡顿，采集相同操作下的性能 profile 和 main/gateway 日志，单独定位阻塞来源。
