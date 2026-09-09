# 定时任务会话重复与执行前失败状态修复设计文档

## 1. 概述

### 1.1 问题

升级 OpenClaw 至 `v2026.8.1` 后，定时任务出现两类异常：

1. 同一次执行的用户消息在任务会话中重复展示。
2. 任务在开始执行前失败，运行历史已有错误，但任务仍显示上次成功；首次执行失败则仍显示未运行。

第二类问题的已知错误为 `cron run cannot acquire a durable fence without process start identity`，耗时显示为 0。截图能够确认进程身份缺失，不能单独证明某次 PowerShell 查询超时；查询超时属于结合 Windows 实现分析得到的可能触发条件。

### 1.2 根因

**会话别名被当作执行身份。** 预取使用 `agent:<agentId>:cron:<jobId>:run:<runId>`，后续轮询可能改用 `agent:<agentId>:cron:<jobId>`。两个别名指向同一份 transcript，但 LobsterAI 原先按请求别名维护导入游标和消息身份，导致重复导入。调查日志中，同一次执行先由预取导入，再由基础别名轮询重复导入。

**Windows 进程身份读取不稳定。** OpenClaw 创建持久化执行凭证（receipt）时，必须同时取得 PID 和真实的进程启动时间，用于区分 PID 复用。Windows 原实现的查询超时较短；读取不到身份会在模型执行之前报错。

**失败发生在原有状态收尾之前。** 凭证准备失败时还没有排队预留或有效 receipt，原有收尾路径没有持久化本次错误结果。手动执行外层虽会发出失败事件，但 `cron.list` 读取的任务状态仍保留旧值，与 `cron.runs` 的运行历史不一致。

## 2. 用户场景

### 场景 A：单次执行只展示一份消息

**Given** 用户运行一个定时任务。

**When** 历史预取、轮询和结束同步通过不同别名读取同一份 transcript。

**Then** 同一次执行的每条消息只展示一次；再次执行相同任务时，即使输入输出相同，也保留新执行的消息。

### 场景 B：成功后发生执行前失败

**Given** 一个周期任务已有成功记录。

**When** 下一次手动或自动执行在准备 receipt 时失败。

**Then** 任务状态和运行历史均反映本次失败，刷新或重启服务后仍然一致。

### 场景 C：首次执行即失败

**Given** 任务尚未执行过。

**When** 第一次执行在准备 receipt 时失败。

**Then** 任务显示失败而非未运行，并保留原始错误原因。

## 3. 功能需求

- 同一 transcript 经不同别名同步时幂等，不按消息文本去重。
- Windows 优先通过可靠的进程启动时间查询减少身份缺失，同时保留持久化凭证的身份校验。
- 执行前失败的处理覆盖手动执行、正常定时触发和启动补跑，共用状态更新边界。
- 先持久化错误结果，再发布完成事件；过期失败不得覆盖更新后的任务或新的执行持有者。
- 保持手动强制执行后的原定调度时间，以及自动执行已有的失败退避策略。

## 4. 实现方案

### 4.1 在 LobsterAI 适配层统一消息身份

以 `chat.history` 随消息返回的 `sessionId` 作为 transcript 身份，构造统一的运行历史键，并与原始消息索引共同标记已导入消息。请求使用的会话别名继续负责路由。

如果响应没有可用的 `sessionId`，只允许显式运行别名中的 `:run:` 后缀作为回退；基础别名本身不能区分多次执行，需等待后续响应提供身份再导入。这样也避免依赖 `sessions.list` 与 `chat.history` 之间可能已经变化的别名映射。

每个本地会话只保留一个包含运行历史键和消息数量的游标。别名切换不清空游标，transcript 变化时重新计数；重新打开会话时结合已持久化的消息身份恢复幂等性。

### 4.2 迁移上游 Windows 进程身份修复

`scripts/patches/v2026.8.1/openclaw-windows-process-identity.patch` 迁移上游提交 [97bc908f](https://github.com/openclaw/openclaw/commit/97bc908f8850872b960c36dfb58752f6c3a3b653) 的实现和回归测试：

- cron、Gateway 锁、端口检查和 node worker 共用 Windows 进程启动时间读取器。
- CIM/PowerShell 查询默认使用 5 秒超时，WMIC 回退使用总计 10 秒预算中的剩余时间；显式传入的更短预算仍然生效。
- 仅缓存当前进程成功读取的身份；其他 PID 每次重新读取，避免 PID 复用造成误判。
- 两种查询都失败时仍然拒绝创建凭证，不使用伪造的启动时间。

补丁不包含上游 CI 路由和 smoke 命令调整，因此 Windows Gateway E2E 需显式执行。该逻辑属于 OpenClaw 内部的进程身份与持久化凭证机制，在 LobsterAI 层绕过校验会破坏原有语义。

### 4.3 在 OpenClaw 共享准备边界收尾失败

`scripts/patches/v2026.8.1/openclaw-cron-preparation-failure-state.patch` 在 `persistQueuedCronRunReservations` 中逐个准备候选任务，只捕获 receipt 准备阶段的异常，交给 `finishCronRunPreparationFailure`：

1. 在运行状态事务内确认任务仍存在、配置及上次运行状态未变化、服务生命周期未变化，且没有其他排队标记、运行标记或有效 receipt 持有该任务。
2. 复用 `applyJobResult` 记录错误，标记 `executionStarted: false`，执行耗时为 0，保留错误诊断及原有调度策略。
3. 持久化成功后更新内存状态，再发送失败通知和完成事件。自动批次中一个任务准备失败，不阻止其他任务继续准备。
4. 手动执行保留原请求的 `runId`，通过既有终态跟踪避免重复发送完成事件。

若事务发现任务已变化，自动调度放弃过期结果；已接受的手动请求仍得到一次终态事件，但不覆盖新状态。若持久化本身失败，同时保留准备错误和持久化错误供调用方诊断。

这一状态属于 OpenClaw 调度器。在 LobsterAI UI 根据历史修补状态会形成第二份状态来源，也不能完整覆盖自动调度，因此使用版本化补丁修复共同边界。

### 4.4 补丁维护与涉及文件

| 文件 | 职责 |
|------|------|
| `src/shared/cowork/openclawCronSessionKey.ts` | 解析别名并生成统一运行历史键 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 按 transcript 身份同步消息及维护游标 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts` | 覆盖别名切换、重复文本、重新打开和身份缺失 |
| `scripts/patches/v2026.8.1/openclaw-windows-process-identity.patch` | Windows 进程身份实现和上游测试 |
| `scripts/patches/v2026.8.1/openclaw-cron-preparation-failure-state.patch` | 共享准备边界的失败状态实现和测试 |
| `src/main/libs/openclawPatches/v20260801UpgradeDecisions.test.ts` | 严格核对包含新增两个补丁在内的 25 个已审查补丁 |

Windows 身份修复已包含在上游 `v2026.8.2`。升级到包含该提交的版本，并通过进程身份和实际 Gateway cron 回归后，可移除对应补丁。

准备失败状态补丁暂没有对应上游提交。待上游提供等价实现，并通过首次失败、成功后失败、并发持有者、定时触发、启动补跑及持久化失败测试后再移除。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 同一次执行在基础别名与运行别名之间切换 | 使用响应中的 transcript 身份，避免重复导入 |
| 不同执行产生相同文本 | 按不同 transcript 分别保留，不做文本去重 |
| 基础别名响应缺少 `sessionId` | 暂缓导入，避免把多次执行归为同一次 |
| Windows 两种身份查询均失败 | 保留真实失败并更新任务状态，不绕过凭证校验 |
| 任务被编辑、删除，或被其他执行持有 | 过期失败不能覆盖新状态 |
| 服务停止或生命周期已变化 | 不提交旧生命周期中的失败状态 |
| 手动强制执行早于原定时间 | 保留后续原定调度时间 |
| 自动批次中一个任务准备失败 | 其余候选任务继续处理 |
| 准备失败后的状态持久化也失败 | 报告两个错误，不伪装为已完成状态更新 |
| 升级前已有重复历史或陈旧状态 | 本次不进行无法可靠归属的历史数据迁移 |

## 6. 验收标准

- 同一执行经过预取、轮询、结束同步和重新打开会话后，每条消息仍只出现一次；相同内容的两次执行均完整保留。
- 首次执行及成功后的执行，在 receipt 准备阶段失败时，`cron.list` 与 `cron.runs` 均反映失败，重新加载状态后保持一致。
- 手动、定时及启动补跑入口均覆盖准备失败；并发任务变化或新持有者不会被旧失败覆盖；手动请求只收到一次对应 `runId` 的终态事件。
- Windows 实际 Gateway cron E2E 成功执行，并验证完成记录包含真实的 owner PID、进程启动时间及完成时间。
- 补丁清单测试保持完整列表比较，检测遗漏或意外加入的补丁；全量 LobsterAI Vitest 和变更文件 ESLint 通过。

验证补丁时，先在 LobsterAI 仓库运行 `node scripts/apply-openclaw-patches.cjs <OpenClaw 临时检出目录>`，将全部版本补丁应用到专用的 `v2026.8.1` 临时检出目录。该脚本会重置目标检出，不能指向包含未保存开发修改的目录。

在应用补丁后的 OpenClaw 目录中，用 `node scripts/run-vitest.mjs run <测试文件>` 执行准备失败、进程身份及相邻调度回归。在 Windows 上显式执行 `node scripts/run-vitest.mjs run --config test/vitest/vitest.e2e.config.ts test/e2e/windows-cron-process-identity.e2e.test.ts`；该测试使用独立 Gateway 和状态目录。

用户界面回测覆盖单次消息不重复、连续两次相同任务保留各自结果，以及刷新和重启后的状态一致性。普通模型请求失败发生在执行阶段，不能替代 receipt 准备失败的故障注入测试。
