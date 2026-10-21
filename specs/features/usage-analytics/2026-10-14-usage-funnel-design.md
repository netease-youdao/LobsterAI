# 专家与任务链路埋点设计文档

## 1. 概述

### 1.1 问题/背景

专家广场由旧 Agent 模板升级而来，用户从发现专家到实际运行任务，还会经过草稿、能力选择、工具调用、媒体生成和产物使用。已有入口与管理操作埋点不能完整关联这些阶段，难以区分专家受欢迎程度、用户停留、运行失败和结果未被采用。

本设计是产品使用日志的增量，归入既有 `usage-analytics` 主题；保留 2026-06-22 的设计文档作为历史参考。本文完整定义本次事件、关联方式、兼容边界和验收口径。

### 1.2 目标

- 串联专家曝光、召唤、草稿、实际运行与再次使用，支持专家漏斗和排行。
- 将任务、Kit/Skill、工具/MCP、媒体生成和产物交互关联起来，定位受阻阶段与耗时。
- 沿用现有上报和使用统计开关，保护用户内容，明确端侧验证与数仓验收的边界。

### 1.3 范围

本次沿用 `rlog → wisdom`，补充专家发现、草稿、任务运行、能力调用与产物使用的关联数据。初始事件使用 `schemaVersion=1`；2026-10-16 的媒体生成口径修订使用 `schemaVersion=2`，详见第 8 节。不增加日志投递队列、日志重试或数仓写入。

不以完成事件推断用户满意度，不根据旧 Agent 名称或提示词补造专家归属，不重跑历史数据。新增明细字段由数仓配置承接，客户端改动不等于数据已可查询。

## 2. 用户场景

| 场景 | Given | When | Then |
| --- | --- | --- | --- |
| 首次使用专家 | 用户尚未安装目标专家 | 浏览广场、召唤专家并发送草稿 | 可分别观察曝光、准备、草稿、提交和运行，并关联同一专家与发现过程 |
| 再次使用专家 | 用户已有专家实例或历史会话 | 选择已安装专家开启新任务，或续聊 | 可区分实例复用、新任务与续聊，不要求此次访问先有广场曝光 |
| 能力调用受阻 | 任务携带 Kit/Skill，运行时调用工具或 MCP | 工具成功、失败、等待权限或中途取消 | 选择、调用和结果分开记录，可定位到当前任务轮次 |
| 媒体生成 | 用户选择图片或视频能力 | 遇到入口阻挡、确认等待、生成或保存结果 | 可区分用户决策、服务受理、生成完成和本地保存，不重复计数 |
| 产物交付与统计关闭 | 任务产生产物，用户可调整统计设置 | 预览产物或关闭使用统计 | 可靠归因的交互关联产生轮次；关闭统计后停止上报 |

## 3. 功能需求

### FR-1：专家发现与转化

记录广场访问、目录加载、筛选、可见曝光、详情、召唤、实例准备及草稿。使用目录稳定 ID 识别专家；召唤和草稿不能替代实际运行。

### FR-2：任务及能力链路

关联提交、运行开始、首响应、权限等待和结束状态；区分随任务提交的 Kit/Skill 与实际工具调用、Skill 入口读取。流式更新与重复结果不得重复产生终态事件。

### FR-3：媒体与产物

记录媒体入口阻挡、用户确认、受理、生成和保存阶段；异步结果保留请求发起时的归因。产物发现和后续交互使用独立标识，无法可靠归因时明确标注未知。

### FR-4：数据关联、兼容与隐私

新增事件可按事件 ID 去重、按业务分析 ID 关联；保留旧事件语义。遵守统计开关与账号隔离，使用白名单字段和自定义能力脱敏标识，不上传用户内容。

### FR-5：可验收与可分析

分别核查端侧报文、实时日志和延迟数仓数据；明确身份、耗时、成功及未知状态的口径。上线后仅使用实际发布版本与生产环境样本计算指标。

## 4. 实现方案

### 4.1 上报与查询链路

端侧交互和运行观察复用现有日志模块，上报至 `https://rlogs.youdao.com/rlog.php`，产品标识为 `wisdom`。Analyzer2 的 `outlog_wisdom` 实时流用于核对原始字段和值；延迟同步后的 `hive.dso.wisdom` 用于聚合分析。HTTP 200、实时可见和 DSO 入库是三个独立验收步骤。

### 4.2 事件与指标

| action | stage 或现有操作字段 | 可回答的问题 |
| --- | --- | --- |
| `lobsterai_expert_journey` | `view / load / filter / impression / detail / summon / draft` | 是否进入广场、目录能否加载、搜索是否无结果、哪些专家被看到、查看、召唤并进入草稿 |
| 同上 | `catalog_refresh / prepare` | 目录刷新是否失败并使用缓存；专家是安装、复用还是重新启用；是否卡在目录处理或 OpenClaw 配置同步 |
| `lobsterai_task_lifecycle` | `submit / start / first_response / permission / permission_decision / end` | 提交是否被接收、运行是否开始、首响应耗时、权限等待与选择、结束原因 |
| `lobsterai_capability_use` | `select / start / end` | 实际提交了哪些 skill、kit；工具和 MCP 是否调用、失败或中断；是否读取了已安装 skill 的入口文件 |
| `lobsterai_media_lifecycle` | `view / select / login / subscribe` | 用户能否进入媒体能力，是否被登录、权益、企业账号上下文或额度状态阻挡 |
| 同上 | `start / confirmation / accepted / generated / saved` | 是否等待用户确认、用户是否取消、请求是否受理、异步生成是否结束、结果是否完整保存到本地 |
| `lobsterai_artifact_delivery` | `discovered` | 本次渲染进程中提交的任务，其产物是否被客户端识别 |
| `lobsterai_artifact_preview_action` | 保留现有 `actionType`，补充关联字段 | 产物是否被打开、复制、导出、分享，以及相关失败 |

`filter` 仅发送查询长度、分类 ID、是否选择标签和结果数；不发送搜索文本。专家曝光要求卡片至少 50% 进入可见区域；同一广场访问、目录版本、专家与推荐场景组合只计一次，不能用目录条目数当曝光量。推荐区域记录 `scenarioId`，示例问题记录零起始的 `starterIndex`，不记录正文。

召唤成功表示专家实例准备成功；`draft` 表示准备了未发送的草稿。两者均不能当作专家已被使用。`prepareMode=install/reuse/reenable` 来自主进程实例检查。专家排行建议分别展示曝光 UV、召唤 UV、运行 UV、运行次数、后续再次运行 UV，而不是合成一个“热度”计数。

### 4.3 关联、去重与隐私

- `eventId`：每条上报的唯一 ID，主进程补齐此字段以及 `environment`。明细分析先按 `eventId` 去重，再按业务 ID 计算转化。
- `journeyId`：广场访问或已安装专家选择产生的随机 ID；草稿提交后传入任务链路。
- `taskId / turnId`：独立生成的随机分析 ID，与本地 session/message ID 不同。每次提交生成新的 `turnId`，续聊恢复已持久化的 `taskId`。
- `presetId`：专家目录的稳定 ID，取实际 agent 的 preset 归属；自定义 agent 不冒充专家。`catalogVersion` 表示本次发现专家时看到的目录版本，不表示用户修改后的专家内容版本。
- `callId`：本轮工具调用的随机分析 ID。流式更新和重复结果只产生一次完成事件。
- `mediaJobId`：独立于服务端任务 ID 的随机 ID。显式查询状态与后台轮询共享去重记录，异步完成沿用提交时的上下文。
- `artifactId`：渲染进程内用于关联产物发现与交互的随机 ID。重启后不保证相同；没有可靠的产生消息时发送 `attributionKnown=false`，不挂到最新一轮任务。

任务上下文存放在现有消息 metadata 的 `usageAnalytics` 中，无需数据库迁移。`ownerKey / localSessionId` 只用于本地账号核对和隔离分叉会话，经过白名单读取后不会进入上报参数。关闭统计时不启动新追踪；账号变化后的在途结果不会归到新账号。新增逻辑失败不会阻断任务或专家准备。

MCP 和用户自定义工具、skill 标识采用安装范围内的 HMAC-SHA256 摘要（截取 32 位十六进制字符），随机密钥仅保存在本地，不随事件上报。不发送自定义名称、工具参数、错误原文、服务端任务 ID、提示词、文件路径或产物内容。内置工具名使用固定白名单，官方 skill 允许使用目录 ID。新增逻辑不改变旧事件已有字段。

### 4.4 成功与受阻的判定

`task_lifecycle.end` 的 `completed` 只说明本轮运行结束；`completed_with_tool_errors` 表示本轮出现过工具错误。其他结束状态包括 `failed / cancelled / timeout`。这些都不是用户满意度标签。没有结束事件的任务应归为“结果未知”，可能包含客户端退出、网络失败或丢报，不能直接算失败。

工具 `succeeded` 仅表示工具没有返回错误；`skill_load` 表示读取了已安装的 `SKILL.md`，不能证明后续完全执行了 skill。kit 的 `select` 表示随任务提交的能力集合，不能从一次 kit 选择推断整套工作流成功。首响应时间从客户端运行调度开始，到首次 assistant 或工具消息，包含本地准备时间。

媒体 `accepted` 与 `generated` 分开统计。视频确认弹窗用 `confirmation/requested` 和 `confirmation/allowed或denied` 记录，后者的 `durationMs` 是等待用户决定的时间；其他媒体阶段的 `durationMs` 仍从请求开始累计。分析受理耗时时应扣除确认等待，不能将用户停留视作服务端延迟。`saved` 要求保存数量等于预期数量且大于零才算成功；部分保存使用 `partial=true`。产物 `discovered` 只是客户端识别，不证明文件可读或用户采用；结合预览、打开、复制、导出或分享事件判断后续使用。

权限 `permission/requested` 到 `permission/resolved` 的间隔表示等待时间；`permission_decision` 表示用户选择 allow/deny，不代表运行时已接收选择。失败原因经过固定分类，无法确定时使用 `unknown`。旧的 `prompt_control_action/submit_blocked` 继续提供模型、配额等提交前阻挡信息，并补充当前专家草稿归因。

### 4.5 旧模板与其他能力的兼容

`lobsterai_expert_kit_action`、`lobsterai_expert_kit_selected` 继续表示 kit；不重命名、不作为专家事件合并。旧 agent 模板行为仍保留原有历史含义。以前没有保存 `presetId` 的自定义 agent 不按名称或提示词反推专家，历史数据不能强行补成新专家漏斗。

已有 skill、kit、MCP 管理页安装、配置、启停事件继续使用；本次补上 kit 页签切换、随任务提交的能力及运行时工具调用。桌面发起的任务和已接入的 IM 用户回合纳入运行观察；不对无法确认起点的历史导入、后台恢复或计划任务补造开始事件。

## 5. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| 专家目录请求重复、被新请求取代或组件卸载 | 仅当前有效请求记录加载结果；曝光按访问、目录、专家与推荐场景组合去重 |
| 专家已安装、被禁用或旧实例没有 presetId | 记录 install/reuse/reenable；无可靠 presetId 的实例不反推专家身份 |
| 续聊、账号切换或关闭统计 | 同账号续聊恢复 taskId、生成新 turnId；账号变化丢弃旧归因；关闭统计停止追踪与上报 |
| 流式工具结果或媒体轮询重复到达 | 使用调用/媒体分析 ID 去重；异步媒体结果沿用发起时的上下文 |
| 用户在权限或视频确认界面停留、拒绝 | 单独记录等待与决策，不能作为服务生成耗时或工具成功 |
| 产物来源不明确、重启后再次打开 | 无可靠来源时 attributionKnown=false；不挂到最新轮次，artifactId 不保证跨重启稳定 |
| 客户端退出、网络失败、上报不可用 | 埋点失败不阻断业务；缺少终态归为结果未知，不直接计作失败 |
| 历史导入、后台恢复或无法确认起点的计划任务 | 不补造开始事件，不将历史数据强行补成新专家漏斗 |

## 6. 涉及文件

| 模块 | 主要文件 | 职责 |
| --- | --- | --- |
| 事件与字段契约 | `src/shared/analytics/constants.ts`、`src/shared/analytics/usage.ts` | 事件常量、字段白名单、分析上下文与失败分类 |
| 上报入口 | `src/main/libs/mainLogReporter.ts`、`src/renderer/services/usageAnalytics.ts` | 公共参数、事件标识、统计开关与 Renderer 上下文 |
| 专家发现与准备 | `src/renderer/components/experts/`、`src/renderer/services/expertOnboarding.ts`、`src/main/ipcHandlers/agents/handlers.ts`、`src/main/libs/expertStore.ts` | 可见曝光、交互、目录与实例准备结果 |
| 任务及能力 | `src/main/libs/usageAnalytics.ts`、`src/main/libs/capabilityUsage.ts`、`src/main/libs/agentEngine/coworkEngineRouter.ts`、`src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 运行观察、去重、能力识别与 HMAC 脱敏 |
| IPC 与提交 | `src/main/main.ts`、`src/main/preload.ts`、`src/renderer/services/cowork.ts`、`src/renderer/components/cowork/CoworkPromptInput.tsx`、`src/renderer/components/cowork/promptAnalytics.ts` | 分析上下文传递及提交前阻挡归因 |
| 媒体与能力入口 | `src/main/libs/mediaUsageAnalytics.ts`、`src/renderer/components/cowork/MediaModelPicker.tsx`、`src/renderer/components/skillsAndConnectors/SkillsAndConnectorsView.tsx` | 媒体阶段、确认等待及 Kit 页签交互 |
| 产物 | `src/renderer/store/libraryArtifactListener.ts`、`src/renderer/components/artifacts/artifactAnalytics.ts` | 产物发现及原有交互事件的归因 |
| 回归测试 | 对应的 `usage.test.ts`、`usageAnalytics.test.ts`、`capabilityUsage.test.ts`、`mediaUsageAnalytics.test.ts`、`mainLogReporter.test.ts`、`handlers.test.ts`、`openclawRuntimeAdapter.test.ts` | 字段过滤、归因、去重、统计开关与运行接入 |

## 7. 验收标准

### 7.1 端侧行为与报文

1. 专家访问、曝光、召唤和草稿均有对应阶段；发送后可关联实际任务，单次有效目录加载不重复上报。
2. 新任务与续聊可区分；工具成功、失败和取消可定位到当前轮次，重复流式结果不重复计数。
3. 图片和视频的 start、accepted、generated、saved 使用同一 mediaJobId；视频取消记录 confirmation/denied 及取消结果，不继续生成。
4. 产物交互使用可靠的产生轮次；缺少归因时标注未知。旧 Kit 事件继续保持原有含义。
5. 报文的 eventId 唯一，durationMs 非负；不包含用户正文、路径、原始错误或自定义能力名称。关闭统计后不发送新增请求，账号切换不串归因。
6. 相关 Vitest、修改文件 ESLint 及 TypeScript 编译通过；使用真实 Electron 观察业务触发和实际 rlog 请求。定向测试和单次客户端自测不替代完整发行构建及生产数据验收。

### 7.2 数仓验收与分析

预研已用只读查询在 `hive.dso.wisdom` 看到现有 `lobsterai_` 上报，因此可用它检查发布后的新事件是否入库和日事件量。现有 `userid` 是 rlog 侧标识，不能当作客户端登录账号；账号 UV 需使用客户端登录账号对应的 `user_id`。预研时可查询字段不包含 `presetId / stage / taskId / turnId / environment / app_version` 等业务明细；字段扩展工单现已处理，实际 schema、字段映射及生产分区仍需复验，不能据工单状态认定完整漏斗已可查询。无需历史重跑，从配置生效日处理新日志。

`hive.outlog.wisdom` 有 `kv` 明细结构，但当前 Trino 查询受到 `SymlinkReqLogInputFormat` 不支持的限制。需要数仓提供可读的明细表或兼容查询入口；本次不修改数仓。下面的第二段 SQL 是明细契约模板，只有确认真实明细表及字段映射后才能执行。

```sql
-- DSO 入库检查：按上线后的实际分区替换日期。
SELECT day, action, count(*) AS event_count
FROM hive.dso.wisdom
WHERE day = '2026-10-14'
  AND action IN (
    'lobsterai_expert_journey', 'lobsterai_task_lifecycle',
    'lobsterai_capability_use', 'lobsterai_media_lifecycle',
    'lobsterai_artifact_delivery'
  )
GROUP BY day, action;
```

明细需暴露至少 `eventId, action, stage, outcome, user_id, uuid, environment, app_version, uts, presetId, journeyId, taskId, turnId`；其余维度使用同名 kv 字段。生产指标筛选 `environment=production` 和明确的应用版本范围，账号 UV 与安装 UV 分开定义。

```sql
-- 待数仓映射的规范化明细视图模板，analytics_usage_events 不是已存在的表。
WITH dedup AS (
  SELECT *, row_number() OVER (PARTITION BY event_id ORDER BY event_time) AS rn
  FROM analytics_usage_events
  WHERE environment = 'production' AND day BETWEEN :start_day AND :end_day
), runs AS (
  SELECT preset_id, user_id, task_id, turn_id,
         max(CASE WHEN stage = 'start' THEN 1 ELSE 0 END) AS started,
         max(CASE WHEN stage = 'end' AND outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
         max(CASE WHEN stage = 'end' AND outcome IN ('failed', 'timeout') THEN 1 ELSE 0 END) AS failed
  FROM dedup
  WHERE rn = 1 AND action = 'lobsterai_task_lifecycle' AND preset_id IS NOT NULL
  GROUP BY preset_id, user_id, task_id, turn_id
)
SELECT preset_id, count(DISTINCT CASE WHEN started = 1 THEN user_id END) AS run_uv,
       sum(started) AS runs, sum(completed) AS completed_runs, sum(failed) AS failed_runs
FROM runs GROUP BY preset_id;
```

完整漏斗按 `journeyId + presetId` 对齐可见曝光、详情、召唤、草稿和首次启动，再按 `taskId + turnId` 关联工具、媒体及产物；按时间顺序和明确的转化窗口计算。对直接选用已安装专家的入口单独建漏斗，不能要求它先有广场曝光。复用可按用户与专家，在首次启动后的其他任务或后续日期出现新启动计算，区分续聊和再次新建任务。

### 7.3 上线后的核验边界

自动化测试验证端侧事件与关联字段。Hive 延迟入库、ETL 对新增字段的保留和生产丢报率需要上线后检查。当前发送仍为 best effort；主进程并发上限、网络失败、客户端退出或不可用的安装标识都可能造成数据缺口。本次没有增加可靠投递承诺。

## 8. 2026-10-16 媒体与悬浮球漏斗修订

基于 `release/2026.10.13` 的 `03a9e9082`，复用已有媒体默认策略和六类悬浮球事件。本次只修正媒体生命周期口径及恢复关联，并为悬浮球任务补充逐次提交关联；不扩展朗读实际播放、首响应或详细登录流程。

### 8.1 媒体生成口径 v2

主进程生成链路的 `lobsterai_media_lifecycle` 使用 `schemaVersion=2`。渲染层已有的入口、选择等事件仍沿用原版本。分析生成漏斗时应筛选版本，并按 `mediaJobId` 聚合；`selectionSource=user/default/off` 和 `policyVersion` 继续来自本轮实际生效的媒体选择。

| 阶段 | 口径 |
| --- | --- |
| `start / started` | 一次生成工具调用开始；同一次调用重入复用 `mediaJobId` |
| `submit / started` | 即将发出服务请求；`protocolVersion` 区分旧接口与持久任务协议 |
| `submit / unknown` | 响应丢失、持久任务 5xx 等情况下接单结果待确认；不是接单成功或最终失败 |
| `accepted / succeeded` | 已取得有效服务端任务 ID；恢复原意图后可补充这一阶段，分析 ID 保持不变 |
| `generated / succeeded/failed/cancelled/timeout` | 实际生成终态；取消接口返回成功只表示取消请求被接收，须等待状态查询或轮询确认终态 |
| `delivery_attempt / failed` | 持久任务一次本地保存失败或部分成功；记录 `attemptCount`、`savedCount`、`outputCount`、`partial`，后续仍可重试 |
| `saved / succeeded` | 本地保存数量等于预期数量且大于零，只计一次；`attemptCount` 包含此前失败的保存尝试 |

旧协议保留原有一次性 `saved / failed` 行为。持久任务首次下载失败不再锁死保存结果，后续完整保存可以产生 `saved / succeeded`。没有完整保存事件的任务归为“尚未确认交付”，不能将一次 `delivery_attempt / failed` 当作最终交付失败；同样不能用所有保存尝试条数计算任务数。

持久任务在发请求前保存一份本地关联快照，包含随机分析 ID、原始分析上下文、模型/策略摘要、终态与保存去重标记。恢复查询与后台轮询共同使用它，避免重启后重复受理、生成或保存计数。快照按账号和服务地址隔离，最多 500 条，仅恢复 7 日内记录，过期记录在后续保存时淘汰；关闭统计时清除快照并使在途结果失效。不会从升级前的业务任务补造分析起点。

服务端任务 ID、工具调用原始 ID 和账号范围仅作本地索引，不进入 rlog；快照不包含提示词、请求正文、输出 URL 或文件路径。无法确认桌面轮次的原生 OpenClaw run 不借用同一会话的最近桌面归因。快照不是可靠投递队列：先更新去重标记再尝试上报，退出或网络失败仍可能丢报，不能据此承诺端到端 exactly-once。

### 8.2 悬浮球提交与执行关联

复用 `lobsterai_desktop_companion_action` 和 `lobsterai_desktop_companion_task`，不新增事件族或 IPC 通道。

- 每次面板打开请求生成 `journeyId`，放入已有 `interactionType=open, surface=panel` 事件；同次面板提交沿用该 ID。打开请求仍不能当作完成渲染的曝光。
- 每次任务提交生成随机 `callId`，`submit` 与 `result` 共用；来源由主进程确认。一次提交最多产生一个结果，跨窗口、账号变化或关闭统计后的旧结果不关联。
- 主进程在 Cowork IPC 入口捕获当前窗口的提交，并在运行时派发的同步阶段保存实际 `taskId / turnId`。成功的 `result` 使用这份快照，不在回调时读取会话最新轮次；拒绝提交或没有新轮次时不猜测任务归因。
- 文件拖放快捷任务与结果卡追问各有本次提交的 `journeyId`；本次未将它们与文件条、通知或提示气泡曝光逐次串联。

面板漏斗按 `journeyId` 连接打开请求和提交，再按 `callId` 连接提交结果；成功结果按 `taskId + turnId` 连接 `lobsterai_task_lifecycle` 的运行开始与结束。文件快捷任务和追问从 `desktop_companion_task.submit` 起算。`result/success` 仍只表示创建/续聊被接收；执行成功、失败、取消和未知由已有运行事件判断。

这些 ID 都是独立的随机分析 ID，不上传本地会话 ID。悬浮球的 `journeyId` 表示入口操作，不能假定等于任务原有的专家发现 `journeyId`；二者通过 `taskId + turnId` 关联。UUID 不可用时允许退回无关联的旧事件，不能将这种样本用于逐次转化率。

### 8.3 验收与数据映射

自动化回归覆盖：待确认不能计为受理、重启恢复同一分析 ID、保存失败后重试成功、重复状态去重、取消请求与真实终态、账号/服务地址隔离、关闭统计后再启用不恢复旧追踪，以及悬浮球晚到结果不能串到下一轮。

上线验收须确认实时日志和数仓同时保留 `schemaVersion / protocolVersion / attemptCount / selectionSource / policyVersion / mediaJobId / callId / journeyId / taskId / turnId` 及阶段结果字段。已有工单字段映射不等于这些增量字段已经入库；本次只修改客户端和文档，未修改数仓。按实际发布版本和生产环境筛选后再计算漏斗。
