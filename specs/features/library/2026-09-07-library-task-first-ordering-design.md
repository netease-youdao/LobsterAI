# “我的文件”本地产物任务优先排序设计文档

> 创建日期：2026-09-07
>
> 状态：代码已落地，自动化验证完成，待跨平台人工验收
>
> 项目：LobsterAI Electron 客户端
>
> 产品入口：「我的文件」→「本地产物」
>
> 上一版：`specs/features/library/2026-09-04-library-task-first-ordering-design.md`

## 0. 修订范围与结论

本版完整定义本地产物的任务优先排序、分页、刷新、兼容与验收合同，替代 2026-09-04 版本在本主题上的要求。2026-08-17 资料库基础 Spec 中与本版冲突的本地排序、分组、游标和刷新条款以本版为准；其他能力继续有效。2026-08-31 加载反馈设计的保留内容、无整页闪烁和查询切换规则继续有效。旧文档保留为历史参考。

设计结论：任务按最近活动时间倒序，任务内文件按最后修改时间倒序。文件唯一归属仍由最新有效关系确定。Main 在分页前完成归属和排序；Renderer 展示同一任务的连续产物，并在排序变化后重建有效游标。

本轮评审问题及修订如下：

| 评审问题 | 本版确定的处理 | 对应章节 |
| --- | --- | --- |
| 只重读 N 条可能丢失原滚动锚点 | 保留连续全局前缀，额外顺序补读最多 200 条；虚拟行定位；超限明确降级 | §5.3～§5.5 |
| 会话更新时间的写入口覆盖不全 | 列出完整写入矩阵，按提交前后实值比较通知，保留各入口既有时间语义 | §2.2、§4 |
| 历史时间可能含小数毫秒 | SQL、响应、比较器和游标保留同一原始数值，不增加整数限制、不回填 | §2.3、§3.3 |
| “继续聊天不改变归属”的承诺过于绝对 | 关系时间不同时不改变；相同时保留会话时间兜底，单独测试 | §2.1、§8 |
| 旧 Main 的字段回退不能解决协议不匹配 | 首页面响应校验协议，停止跨版本续页；提示重启，不伪造任务时间 | §6 |
| 多页刷新及持续事件的成本未定义完整 | 独立浏览深度、候选结果代次、软时间预算和单次即时重试；补多页性能门槛 | §5、§8.4 |

下文保留设计合同；实施及验证记录见 §10。自动化通过不等于跨平台人工验收或端到端性能已达标。

## 1. 当前行为、目标与产品取舍

### 1.1 实施前代码行为

本次实施前，代码采用以下流程：

1. `LibraryIndexService` 读取文件 `mtimeMs` 并截断至整数毫秒；`LibraryLocalStore` 将其存入 `file_mtime_ms/sort_time_ms`，缺少文件时间的写入使用首次发现时间兜底。
2. 列表先应用有效任务关系、类型、关键词、收藏条件，并排除 `missing`。
3. SQLite 按 `sort_time_ms DESC, id DESC` 读取默认 24 个文件，游标是未显式标版本的 `{ sortTime, itemId }`。
4. Renderer 按文件修改日期分组，每个日期内再按最新有效任务分组。任务组位置由该日组内最新文件决定，同一任务可能跨日期出现多个组头。

代码依据包括 `src/main/library/libraryLocalStore.ts`、`src/main/library/libraryIndexService.ts`、`src/renderer/components/library/libraryDateGrouping.ts` 和 `LibraryView.tsx`。

### 1.2 目标

- 用户能按最近使用的任务查找其当前归属文件；最近任务引用旧文件时，文件跟随任务出现。
- 一个任务不再按文件修改日期拆成多个组。
- 查询、续页、定向更新和分组采用同一确定性顺序。
- 历史数据直接可读，文件时间、真实文件、收藏及关系记录不重写。
- 对后台变化提供有界、可取消的刷新；明确滚动恢复的保证范围。

### 1.3 接受的产品代价

| 场景 | 目标行为与取舍 |
| --- | --- |
| 继续旧任务但没有新文件 | 整个任务组可能前移；“今天”表示任务今天活动，不表示文件今天生成 |
| 在外部编辑器修改旧任务文件 | 仅组内文件顺序变化，任务组不会因此前移 |
| 最近任务拥有 120 个文件 | 可以连续占据五页；其他任务在该任务已匹配文件耗尽后出现 |
| 同一文件被多个任务关联 | 仍只展示一次，归属于最新有效关系选出的任务；并非每个任务的历史全量文件清单 |
| 大任务前移导致原文件远离当前窗口 | 在额外读取预算内恢复；超出预算保留尽可能接近的阅读位置并提示排序已更新 |

首期不增加任务折叠、排序选择器或任务级分页。不继承任务置顶。云端分享文件、网站、预览格式、服务端 API 和 OpenClaw Runtime 的排序及协议不在变更范围。

## 2. 归属、任务时间与排序合同

### 2.1 先确定文件唯一归属

对仍存在的任务关系，依次按以下字段降序选一个 owner：

```text
relation.lastRelatedAt → session.updatedAt → sessionId
```

这是现有规则，列表、定向读取与详情必须复用同一个实现。它与任务组的展示排序分开定义：

- 若 A、B 的关系时间不同，纯文本继续 A 不会覆盖关系时间更晚的 B。
- 若 A、B 的关系时间完全相同，继续 A 后 `updatedAt` 变大可以使 owner 从 B 切到 A。这是保留的历史行为，需要重新归组。
- owner 任务删除后按剩余有效关系重选；最后一条有效关系删除后退出列表，真实文件、内部文件索引与收藏保留。
- 一文件一条记录依据既有规范化 `path_key` 去重，不新增重复卡片或任务历史副本。

不得再写无条件的“纯文本继续任务不会改变 owner”验收。

### 2.2 “会话时间”采用真实持久化的 `updated_at`

主时间源为 `cowork_sessions.updated_at`，创建时间只作次级排序。Library 消费提交后的真实值，不自行 touch、不统一改写 Cowork 时间政策。

默认 `updateSession` 的真实状态切换会更新时间；相同状态、无其他投影变化、没有强制 touch 时不发 Library 事件。用户 `addMessage/insertMessageBeforeId` 会写用户消息时间；助手或工具消息本身不更新时间。两种历史替换方法以 `MAX` 推进至更晚用户消息。

必须保留并准确处理以下例外：

- `updateSession(..., { touchUpdatedAt: true })` 可以显式更新时间；定时投递后的助手消息镜像使用此路径。
- `upsertSubagentChildSession` 更新已有子任务时目前直接写 `Date.now()`，即便其状态没变；本次也要通知这类真实变化。
- `resetRunningSessions` 批量将运行中任务置为 idle 并写当前时间。
- 普通 `updateSession` 仅改标题默认不 touch，但其他入口同时改标题、Agent 与时间时，必须消费其真实结果。
- 普通消息写入或系统时钟变化可能使时间向后变化，不能仅以“新值更大”决定是否通知；只有历史替换方法有 `MAX` 的单调约束。

“流式 delta 不导致不断重排”仅指流事件本身不写任务投影的情况，不作为抑制真实数据库变化的理由。完整入口矩阵见 §4.1。

### 2.3 时间兼容：保留小数毫秒

当前历史解析和 `normalizeMessageTimestamp` 接受有限正数，不要求整数。SQLite 的 INTEGER affinity 也允许保存 REAL。不能把数据库列声明或 `number` 类型当成安全整数保证。

本版选择保留原始数值，不进行 `CAST AS INTEGER`、`Math.trunc`、四舍五入、日期格式化后回写或历史回填：

1. 任务 `createdAt/updatedAt`、文件 `sortTime` 从查询结果到响应、排序、游标参数使用相同 JavaScript number。
2. 合法时间是有限数值，且位于 JavaScript Date 的范围 `[-8_640_000_000_000_000, 8_640_000_000_000_000]`；允许小数毫秒，允许范围内的历史零值和负值。
3. JSON 编解码必须保持同一 number 值精确往返；不能使用 `toFixed` 或转换成显示字符串作游标。
4. 日期标题、时分显示可以使用 Date 的显示精度，但不得将显示结果用于排序和续页比较。
5. 非数值、NaN、Infinity 或超范围值视为数据错误，返回明确失败并保留旧快照；不得跳过坏记录后提交短页，也不得偷偷用关系时间或当前时间代替。
6. 索引服务现有文件 `mtime` 取整逻辑保持原样。本条解决读取合同，不扩大文件写入改动。

数值校验集中到共享纯函数，Main、Renderer、游标测试复用；协议版本、页大小等整数控制字段仍按整数校验。

### 2.4 完整排序元组

```text
session.updatedAt DESC
session.createdAt DESC
sessionId DESC
artifact.sortTime DESC
itemId DESC
```

`sessionId` 必须位于文件时间之前，确保同一任务连续。后两项是组内排序，不改变组位置。SQL 和 Renderer 对字符串使用 SQLite `BINARY` 对应的 UTF-8 字节顺序；当前 UUID 的 ASCII 快速比较可直接使用 `<`、`>`，历史非 ASCII 标识须走 UTF-8 字节比较，不能用 `localeCompare`。不因本次排序新增 UUID 形状或 ASCII-only 限制。

所有参与排序字段必须非空且类型合法，数值比较要保留小数。比较器测试同时覆盖时间相同、不同 ID、历史非 ASCII ID。

### 2.5 日期、显示与查询条件

- 先按 owner 的 sessionId 聚合，再按任务元组排序，最后按任务 `updatedAt` 的本地自然日组织日期桶。
- 任务组头显示任务标题和任务活动时分；列表行不新增时间列，网格和预览仍显示文件时间。
- 相同任务跨页并入现有组头。不同日期的文件也在同一任务组内。
- 搜索仍匹配文件名与扩展名，分类与收藏仍按文件筛选；无匹配文件不显示空任务组。
- `counts.total/available/missing` 按文件计算。计数共用关系及查询过滤条件，但 `missing` 统计须在列表排除 missing 之前计算。
- 列表继续显示 `permission_denied` 等现有非 missing 条目，保留不可访问状态。
- 同一 session 的不一致时间投影不能按最大值永久修补；同一响应内视为合同错误，跨请求出现时废弃本轮候选并重读，避免错误地假设任务时间只增不减。

## 3. Main 查询、游标与共享类型

### 3.1 查询顺序

```text
有效关系与查询过滤 → 唯一 owner 投影 → 游标条件
  → 五字段 ORDER BY → LIMIT pageSize + 1 → 批量补齐关系数/收藏
```

默认每页 24，最大每页 100，全部按文件条数计算。不得在解析 owner 前按文件时间截取页面，也不得为返回完整任务组突破单次页大小。

Main 列表与详情复用 owner 规则；分页查询行直接携带其 owner 时间，不再从另一个可能采用不同规则的 hydrate 查询重选 owner。其他关系详情与数量可对当前页批量读取。

### 3.2 SQL 形态

以下为示意，参数全部绑定，类型/搜索/收藏谓词使用现有受控构造器；owner 投影应集中复用。计数使用独立的基础过滤查询，不能直接数下面排除 missing 后的 CTE。

```sql
WITH filtered_artifacts AS (
  SELECT a.*
  FROM library_local_artifacts a
  WHERE a.availability <> :missing
    -- category / keyword / favorites 条件追加于此
), ranked_relations AS (
  SELECT
    r.artifact_id, r.session_id, r.last_related_at,
    r.last_message_id, r.session_artifact_id,
    s.title AS session_title, s.agent_id AS session_agent_id,
    s.created_at AS session_created_at,
    s.updated_at AS session_updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY r.artifact_id
      ORDER BY r.last_related_at DESC, s.updated_at DESC,
        r.session_id COLLATE BINARY DESC
    ) AS relation_rank
  FROM filtered_artifacts fa
  JOIN library_artifact_sessions r ON r.artifact_id = fa.id
  JOIN cowork_sessions s ON s.id = r.session_id
), owned_items AS (
  SELECT fa.*, rr.session_id, rr.last_related_at,
    rr.last_message_id, rr.session_artifact_id,
    rr.session_title, rr.session_agent_id,
    rr.session_created_at, rr.session_updated_at
  FROM filtered_artifacts fa
  JOIN ranked_relations rr ON rr.artifact_id = fa.id
    AND rr.relation_rank = 1
)
SELECT * FROM owned_items
-- 续页才添加 §3.3 的 WHERE；首页不添加空 WHERE
ORDER BY session_updated_at DESC, session_created_at DESC,
  session_id COLLATE BINARY DESC, sort_time_ms DESC, id COLLATE BINARY DESC
LIMIT :page_size_plus_one;
```

内连接确保无有效任务关系的文件在 LIMIT 前被排除。首版不新增 owner 冗余列、不依赖新索引即可实现功能；真实性能须测量。窗口排名可能遍历过滤后的全部关系，并产生临时排序。

### 3.3 v2 游标

游标是 base64url 编码的不透明 JSON，示例特意保留小数时间：

```json
{
  "version": 2,
  "sort": "recent_task",
  "sessionUpdatedAt": 1788470400000.5,
  "sessionCreatedAt": 1788460000000.25,
  "sessionId": "session-id",
  "artifactSortTime": 1788400000000,
  "itemId": "artifact-id"
}
```

校验版本、sort、三个时间的 §2.3 合法性，以及非空、有界字符串 ID：

- itemId 和 sessionId 均使用 `LibraryLimits.MaxIdentifierLength = 200`，按 JavaScript string.length 计数，沿用本地库候选录入对这两类 ID 已有的限制；不是为整个 Cowork 增加 ID 格式要求。
- 解码前检查 `LibraryLimits.MaxLocalCursorLength = 4_096`，限制 base64url 字符数；当前 UUID 及上述边界内的非 ASCII ID 都可以完整编码。
- 编码、解码、候选录入及定向读取共用 ID 校验。游标中的 ID 不截断、不 trim 后替换；非法值报错，合法值与 SQL 键原样比较。不强制 UUID 形状或 ASCII-only。
- 验证历史库路径时覆盖这些边界；若发现绕过既有 Library 入口的超长 ID，应单独明确兼容策略，不能截断 ID 生成无法续页的游标。

版本 2 仍是本功能首次发布的版本号，9 月 4 日文档尚未形成已发布协议。

五字段全为降序，续页条件为：

```sql
WHERE session_updated_at < :session_updated_at
   OR (session_updated_at = :session_updated_at
       AND session_created_at < :session_created_at)
   OR (session_updated_at = :session_updated_at
       AND session_created_at = :session_created_at
       AND session_id COLLATE BINARY < :session_id)
   OR (session_updated_at = :session_updated_at
       AND session_created_at = :session_created_at
       AND session_id COLLATE BINARY = :session_id
       AND sort_time_ms < :artifact_sort_time)
   OR (session_updated_at = :session_updated_at
       AND session_created_at = :session_created_at
       AND session_id COLLATE BINARY = :session_id
       AND sort_time_ms = :artifact_sort_time
       AND id COLLATE BINARY < :item_id)
```

游标由实际返回末项生成，不包含被 pageSize + 1 多取的探测项。非法游标不得被当作“没有游标”悄悄重取首页。稳定数据集下，逐页拼接必须等于全量顺序；有并发写入时遵循 §5 的失效与收敛合同，不承诺跨 IPC 的数据库快照。

### 3.4 共享合同

```ts
export const LibraryLocalSort = { RecentTask: 'recent_task' } as const;
export const LibraryLocalProtocol = { Version: 2 } as const;

interface LibrarySessionRef {
  sessionId: string;
  title: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  lastRelatedAt: number;
  lastMessageId?: string;
  sessionArtifactId?: string;
}

interface LibraryLocalListData {
  protocolVersion: typeof LibraryLocalProtocol.Version;
  sort: typeof LibraryLocalSort.RecentTask;
  list: LocalArtifactItem[];
  counts: LibraryLocalCounts;
  hasMore: boolean;
  nextCursor?: string;
}
```

本地 list options 保留 category、keyword、cursor、pageSize、favoritesOnly；sort 缺省为 RecentTask，且仅接受本地排序枚举。云端继续使用既有 LibrarySort。共享 SessionRef 的所有本机生成入口（含云端项在本机解析任务的辅助函数）补齐任务时间，云端列表排序和服务端 payload 不变。

新增 `LibraryChangeReason.SessionProjectionChanged = 'session_projection_changed'` 和可选 `sessionIds`，沿用 `library:changed`，不新增通知通道。扩展既有 `LibraryErrorCode`，不改原有代码值：

| 常量 / 值 | 场景 | 处理 |
| --- | --- | --- |
| InvalidCursor / `invalid_cursor` | 游标版本、字段或编码非法 | §6.2 的一次首页重试 |
| ProtocolMismatch / `protocol_mismatch` | 首页面协议不支持或缺少新投影字段；可由 Renderer 本地识别 | 停止跨版本读取，提示重启 |
| InvalidLocalData / `invalid_local_data` | 非法时间、页内投影矛盾或不前进的分页合同 | 保留旧内容并报错，不自动清游标循环 |

普通输入错误仍使用 InvalidInput。跨页合法数据发生变化先按 §5 的候选失效处理，不直接认定历史数据损坏。不能依靠匹配英文 error 文本决定重试。所有版本号、原因值、字段选择器、阈值和错误码放在共享或对应模块的 `as const` 常量中。

## 4. 会话变更通知

### 4.1 完整写入矩阵

通知的依据是最外层事务提交前后投影值是否变化，不是调用的方法名、消息角色或 status 是否相同。

| CoworkStore 入口 | 既有时间/投影行为 | Library 处理 |
| --- | --- | --- |
| `createSession` | 初始化 id、title、agent、created_at、updated_at | 新增投影；通常无文件关系，可跳过 Library 广播，后续 recorded 负责出现 |
| `forkSession` | 新任务及消息复制 | 完整成功后发布新增投影；保留原有 fork 语义 |
| `updateSession` | 默认真实状态切换 touch；显式 true/false 可覆盖；可改标题 | 比较实值；相同状态但改标题或强制 touch 也可能通知 |
| `resetRunningSessions` | 批量 running → idle，写 now | 提交前收集受影响 ID，提交后批量通知 |
| `addMessage` | user 写消息时间；assistant/tool 不写任务时间 | user 以最终投影差异为准，其他角色仅在无投影变化时不发 |
| `insertMessageBeforeId` | user 在事务中写 now；找不到锚点时回退 addMessage | 成功路径或回退路径合计一次，不能双发 |
| `replaceConversationMessages` | 更晚历史用户消息以 MAX 更新时间 | 仅最终值改变时通知；保持小数时间 |
| `replaceSessionMessages` | 同上 | 同上 |
| `upsertSubagentChildSession` | 更新已有记录直接写 now，同时可能改 title/agent_id；也可新增 | 覆盖新增及更新；不能套用 updateSession 的“重复状态不 touch”假设 |
| `pinSession` 等仅 pin/pin_order 写入 | 不改变本次投影 | 不触发排序事件 |

定时投递镜像调用 `updateSession(..., { touchUpdatedAt: true })`，由该入口覆盖，无需在 OpenClaw 增加新事件。启动 migration 未改变本次排序投影时无需通知；应用启动及重新进入页面仍执行首次权威读取。

实施时再次全库搜索 `cowork_sessions` 的 INSERT/UPDATE/DELETE，确认没有新增旁路。矩阵必须作为测试输入，不只是备注。

### 4.2 提交后通知边界

在 CoworkStore 内增加一个局部的写入包装边界，配合纯投影比较/事务内合并辅助模块。它不依赖 Renderer 或 Library 的 UI 类型，也不改消息/任务公共 CRUD 返回值：

```text
收集受影响 sessionIds 的 before 投影
  → 执行现有 SQL/事务
  → 读取 after 投影并在当前事务日志中合并
  → 最外层 COMMIT 成功
  → 发出一次合并通知
```

- 投影字段包括 title、agentId、createdAt、updatedAt。createdAt 当前不可变；如将来有修复入口改它，也不能漏掉次级排序键变化。
- 比较事务开始时和提交后的最终值；同事务多次更新后恢复原值，不发送伪变化。
- 嵌套写入合并到外层日志，回滚丢弃日志。矩阵入口被外层事务包裹时，通知边界必须提升到该外层事务。
- 不用异步微任务猜测提交完成，不对数据库对象做全局 monkey patch，不在每个调用方重复拼通知。
- 监听器异常隔离、记录告警，不使已提交写入变成失败；应用退出解除订阅。
- 主进程只在提交后将变化转换为 Library 通知。可批量筛掉没有任何资料关系的任务；有关系任务即使当前不是 owner，也可能参与同时间归属重选，不能只查当前 owner。
- 本轮不重构整个 CoworkStore，不改变其既有 touch 政策。局部包装器、辅助文件边界和迁移步骤见 §7。

### 4.3 删除通知

删除日志记录去重的 sessionIds 和 affectedArtifactIds，并覆盖：

| 入口 | 外层提交边界 |
| --- | --- |
| `deleteSession` | 单任务删除事务 |
| `deleteSessions` | 批量删除事务 |
| `deleteAgent` → `deleteSessionsForAgent` | Agent 删除的最外层事务 |
| `createAgent` 清理同 ID 孤儿任务 | Agent 创建的最外层事务 |

统一发 `session_deleted`，删除优先于同事务该任务的投影变化。Main 单删/批删 handler 的手工广播在接入统一通知后移除，避免重复。没有受影响文件时可不广播 Library 事件；若兼容路径无法提供 ID，发一次无 ID 的权威刷新信号。

`deleteSessionsForAgent` 不能再把已收集的文件影响信息丢失于内部返回值中。保留原有删除 API 返回类型，通过事务通知日志传递该信息。

## 5. Renderer 刷新、分页与阅读位置

### 5.1 最小状态与失效规则

每个本地查询维护：查询代次、已提交 list/counts/cursor、cursorValid、dirty、浏览深度 browseDepth。另维护单调递增的本地变更代次 dataEpoch、读取 requestId 和恢复 token。

- 冷加载及用户查询切换从 24 条开始；正常滚动续页成功时将 browseDepth 更新为结果总长度。
- 仅用于恢复锚点的自动补读不得增加 browseDepth，避免下一次刷新又多读 200 条而持续扩大窗口。
- 当前尚未实现的 LRU 查询缓存不作为本功能前提；维护当前查询及本地变更代次即可。若保留其他查询快照，须记录 epoch，激活旧快照时先校验；云端缓存不失效。
- 会话投影变化、repair、无 ID 删除始终要求权威刷新。单次会话变化不能只更新已加载 itemIds。
- 有后续页时，已加载项的排序键、owner、查询资格变化，或新项应插入当前窗口，都使游标失效。位于末游标之后且不影响当前成员的变更可留给续页。
- 所有结果已加载、没有其他 dirty/在途读取时，文件定向变更可以按 ID 合并并重排。会话投影变化仍重读。
- 收藏事件不能再被协调器无条件忽略：普通查询中仅布尔值变化可乐观更新；favoritesOnly 中成员变化要重建分页窗口。
- 有 ID 删除在有后续页时重读；完整加载时可定向重选归属/移除。删除后同时更新预览或操作目标的可用性。

比较器和分组提取为纯模块；保持有效关系、查询资格与 Main 一致。会导致边界不可信的本地推断只用于触发重读，不替代数据库权威结果。

### 5.2 收到事件时立即失效，读取时合并

1. 事件到达即推进相关 dataEpoch、标 dirty 并暂停失效游标的 append，不等 300ms 后才失效。
2. 协调器沿用 300ms 静默窗口、1,000ms 最大等待。任何时刻只有一个刷新执行及一个合并中的尾随批次。
3. 刷新捕获 queryGeneration、requestId、dataEpoch；全部页面先进入候选缓冲，不逐页替换 UI。
4. 每次 await 后及提交前检查代次。查询变化、组件卸载或相关事件到达使候选过期，丢弃后不清除新的 dirty。同轮页面若出现 counts 或同一任务投影不一致，即使事件尚未到达，也按候选失效处理并进入同一有限重试流程。
5. 过期 append 响应不提交。协调器的页面激活状态与“当前是否在读取”分开，不能因页面处于 Appending 而阻止事件标脏。
6. 一轮变更批次共用一次即时重试额度，重试开始不能重置额度。第二次候选失效后保留旧内容、禁旧游标续页，等待连续 1,000ms 无相关变化再尝试；此退避优先于协调器的最大等待时间。只有成功提交、查询切换或满足稳定期后才重置即时重试额度，持续写入不能形成无界紧密重读循环。
7. 页面隐藏时只累计失效信息，返回读取当前查询。事件停止后应收敛；不承诺持续写入时跨多个 IPC 页严格实时一致。

一次已观测 epoch 内完成的候选才能提交；未来迟到事件仍会再次使它失效。事件代次不是 SQLite 快照，也不需要增加数据库快照服务或新的定位 IPC。

### 5.3 连续前缀与有界锚点补读

设 N = max(browseDepth, 24)。本轮目标先读取当前条件下前 N 个文件，来源不足时读到耗尽；每次不超过 100 个。

当用户位于中部且锚点不在新前缀内时，允许从新末游标继续顺序补读：

| 常量 | 首期值 | 用途 |
| --- | --- | --- |
| DefaultPageSize / MaxPageSize | 24 / 100 | 沿用现有分页限制 |
| AnchorExtraItemLimit | 200 | 单轮全部锚点最多额外接收的文件数 |
| AnchorExtraRequestLimit | 2 | 基础 N 条之后最多两次额外 listLocal 请求 |
| AutomaticReadBudgetMs | 2,000 | 本轮基础读取及补读共用的软耗时预算 |
| AnchorCandidateLimit | 8 | 当前可见文件及其相邻候选数量 |
| AnchorCorrectionLimit | 2 | 虚拟行挂载后的最大像素校正次数 |
| TopThresholdPx | 24 | 顶部刷新保持顶部 |

约束：

- 只顺序续读并展示中间全部文件，不能 `getLocalItems(anchorId)` 后把孤立锚点拼到尾部，也不能跳过一段排序结果。
- 基础 N 条完成后，从同一游标补读，找到目标或耗尽即停止。额外请求的 pageSize 不超过剩余 200 条额度。
- 该限制约束额外接收的数据；单次 pageSize + 1 的 hasMore 探测沿用现有做法。
- 自动补读本轮最多使候选长度达到 N + 200；之后浏览者正常向底部续页，才将实际新长度纳入 browseDepth。
- 时间预算在发下一次请求前及响应后检查，不能抢占正在执行的 SQLite 同步查询。
- 未完成基础 N 条就超预算：丢弃候选、保留旧快照、标记刷新待重试，禁旧游标 append；不提交截短的新前缀。
- 已完成基础 N 条但额外预算耗尽：可提交已得到的完整连续前缀，按 §5.4 降级恢复位置。
- 预算耗尽后不对同一 epoch 立即自动循环重试；后续新事件或重新进入可重试。用户主动点击刷新允许从首页 24 条重新建立窗口并回到顶部，界面要说明这一行为。
- 响应声称 hasMore 但无有效 nextCursor、游标不前进或连续页没有新增 ID，终止本轮并报合同错误；禁止重复取首页或无限循环。
- 每页必须按五字段严格递减，且页内 itemId 不重复，否则报合同错误。后页首键须严格小于前页末键，整个候选不得重复 itemId；跨页违反时按 §5.2 的候选失效及有界重读处理，不能通过 appendUniqueItems 静默去重后宣称前缀完整。

例：原窗口 48 条，C 的 120 个文件前移，原锚点从第 36 位移至第 156 位。可以在额外 200 条内找回，并提交包含中间文件的连续前缀。若 C 有 1,000 个文件，额外预算内无法找回，就执行降级，不承诺原文件仍在屏幕。

### 5.4 选择与恢复锚点

1. 记录首个可见 itemKind:itemId、相对滚动容器偏移，以及最多 8 个有序邻项；同时保存当前像素 scrollTop。
2. 顶部用户跳过锚点补读，提交新前缀后保持顶部，以看到最近任务。
3. 中部优先恢复原文件；原文件被过滤/删除时从候选中选择仍出现在新前缀的最近邻项。
4. 原文件可能只是未进入新前缀，不能把它当作删除；先执行 §5.3 的有界补读。
5. 候选全部超出预算或已不可见时，保存当前像素位置，并夹到新滚动范围 `[0, maxScrollTop]`。通过低干扰本地化状态提示“列表已按最近任务更新，当前位置可能已变化”。这是明确降级，不伪称保持了原文件。
6. 若读取期间用户继续滚动，提交前采集其最新锚点/像素位置；可使用剩余额度寻找，但不能重置额度。无法涵盖新目标时按同一降级规则处理，禁止恢复早先过期锚点。
7. 新结果为空时展示真实空态，滚动回零；这是来源耗尽，不是加载骨架。

该合同只保证“预算内且目标仍在结果中时恢复文件”，不再承诺任意大任务移动都能同时满足固定读取量和原文件可见。

### 5.5 虚拟列表恢复

`LibraryVirtualizedGroups` 以新的日期/任务/文件虚拟行数组生成 `itemKey → rowIndex`，由组件内已有 virtualizer 完成两阶段恢复：

1. 对目标新 rowIndex 调用滚动定位，使该行挂载；不能只查询当前 DOM 中有没有目标文件。
2. 下一次 layout/rAF 中取得真实位置，按记录的相对偏移校正，最多两次；考虑 scrollMargin、网格列数和测量高度。

恢复 token 绑定 queryGeneration、requestId、viewMode 和用户滚动代次。用户再次滚动、切换查询或视图时取消旧恢复；布局 resize 后用当前列数重算映射。程序执行的 scrollToIndex/像素校正不推进用户滚动代次，避免恢复过程取消自己的 token；识别用户滚动应结合 wheel、touch、键盘、滚动条操作等真实输入，不能将所有 scroll 事件视为用户意图。

刷新与程序恢复阶段暂停 sentinel append。后台刷新结束时，若 sentinel 已因新布局或程序滚动进入加载阈值，不能仅凭 IntersectionObserver 的初始回调自动续页；等待用户再次主动向下浏览或显式加载更多，才重新启用续页。仅真实浏览触发并成功完成的续页才推进 browseDepth，避免降级夹到页面底部后绕过额外 200 条预算。冷加载的首屏填充可以保留，但不适用于后台重排恢复。

成功结果一次提交 list、counts、hasMore、nextCursor；游标必须对应实际展示连续前缀的末项。不能混用新 list 和旧 cursor。预览按稳定 ID 保留，排序变化本身不关闭预览；若预览文件在本轮前缀之外，按 ID 独立刷新预览数据，不把它插入列表破坏前缀。

### 5.6 加载、错误与用户反馈

- 冷加载、查询切换、后台校验、手动刷新与 append 沿用各自的加载状态；后台重排不卸载既有内容、不显示整页骨架。
- 数据读取失败保留旧内容，dirty 保持，旧 cursor 只能存作快照而不可用于续页；使用现有刷新动作重试。
- 因自动读取预算而待重试时，显示“列表有更新，点击刷新将回到顶部”；用户主动刷新按 §5.3 从首页建立新窗口。
- 仅在降级真正发生时展示位置变化提示，不为每个普通后台事件刷提示。
- 新 UI 文案、协议不匹配提示及错误信息必须补充中英文 i18n。开发日志只记录耗时、条数、代次和原因，不记录文件路径、关键词、任务标题或 ID。

## 6. 兼容、发布与回滚

### 6.1 首页面协议检查

不支持新 Renderer 与旧 Main 混用排序或游标。无需新探测接口，也不构建双排序兼容层：

1. Renderer 无 cursor 的首页请求省略 sort；新 Main 默认 RecentTask 并返回 `protocolVersion: 2` 和 `sort: recent_task`，旧 Main 能返回其旧格式响应。
2. Renderer 在提交任何任务优先结果前校验协议元信息及完整时间字段。缺字段或版本不支持时进入协议错误状态，禁止 append，提示“请重启应用以完成更新”（开发态同样需重启 Electron）。
3. 校验成功后，后续续页显式携带 RecentTask 和本轮 v2 cursor。
4. 不使用 `lastRelatedAt` 伪造缺失任务时间，不把旧文件顺序临时包装成任务顺序，不自动重启应用。
5. 普通网络/IPC/参数错误沿用其错误处理，不将所有失败推断为版本不匹配。

getLocalItems、详情及本机云端关联任务的投影也须满足完整字段合同。任一已接入路径暴露旧投影不能用 UI fallback 掩盖；Main、Preload、共享类型和 Renderer 在正式包中同版本发布。

### 6.2 旧游标与合法历史数据

- 原 `{ sortTime, itemId }` 游标仅驻留页面内存，视为 v1。新 Main 对其返回集中定义的游标错误，不能静默解析成 v2。
- 确定的 cursor 错误最多从无游标首页重启本轮读取一次，与 §5.2 共用即时重试额度；该首页仍须通过协议检查。已浏览窗口仍遵循 N 条基线和锚点规则，不在后台悄悄缩为 24 条。重试失败停止，只有用户主动刷新才按 §5.3 重置到首页，不能无限循环。
- 正常应用重启自然从无游标首页开始。
- 小数毫秒按 §2.3 原样兼容，无需数据库迁移或索引回填；不增加 owner 冗余列，不修改 `LIBRARY_INDEX_POLICY_VERSION`。
- 用户文件路径、关系、收藏、缺失与权限记录保持原数据。

### 6.3 项目范围及回滚

只改 LobsterAI 客户端及其本地 SQLite 查询，不要求 lobsterai-server、lobsterai-admin、lobsterai-portal 或 OpenClaw Runtime 配套发布；不改 endpoints.ts、云端联调文档或远端排序接口。

回滚可恢复旧文件排序、旧分组和 v1 游标并停止任务投影排序刷新；本地数据与用户文件无需恢复。新删除通知边界若保留，须仍保证只广播一次；若回滚该边界，恢复原调用方广播，不能同时存在两个来源。辅助索引只有压测证明必要后另行评审，不能在本版未实施时宣称已添加或已达标。

## 7. 模块边界与实施顺序

### 7.1 局部模块计划

| 文件/模块 | 本次责任 |
| --- | --- |
| `src/shared/library/constants.ts`、`types.ts` | 本地 sort、协议元信息、游标错误与事件合同、会话时间字段 |
| `src/shared/library/localOrdering.ts`（新） | 纯时间校验、五字段比较、BINARY 字符串比较；Main/Renderer 复用 |
| `src/main/library/libraryLocalStore.ts` | LIMIT 前 owner 投影、排序、游标与批量 hydrate；不新增运行时文件扫描 |
| `src/main/library/libraryIpc.ts` | sort/协议/游标校验，明确失败；沿用现有 IPC channel 常量 |
| `src/main/libs/sessionProjectionNotifications.ts`（新） | 最小投影类型、before/after 比较、事务内通知合并辅助；不直接发送 Library IPC |
| `src/main/coworkStore.ts` | §4 矩阵入口接入局部提交后边界，保持 CRUD 返回值和既有 touch 语义 |
| `src/main/main.ts` | 订阅/释放会话通知，转换 Library 事件，移除重复删除广播 |
| `src/main/library/libraryIndexService.ts` | 复用通知入口及关系预检；文件 watcher 逻辑保持 |
| `src/main/ipcHandlers/agents/handlers.ts` | 验证级联删除通知由统一提交边界覆盖，不再遗漏 |
| `src/main/preload.ts` | 共享类型透传，无新增通道 |
| `src/renderer/components/library/libraryTaskGrouping.ts`（新） | 纯任务/日期分组，复用 shared comparator |
| `src/renderer/components/library/libraryWindowRefresh.ts`（新） | 可注入读取函数的候选窗口、代次、browseDepth 与补读预算逻辑 |
| `libraryLocalQueryState.ts`、`libraryRefreshCoordinator.ts` | 定向合并安全判定、即时失效、单执行/尾随与退避 |
| `LibraryView.tsx`、`LibraryVirtualizedGroups.tsx` | 接线及虚拟行锚点恢复；不给大型 View 增加独立状态机实现 |
| `src/renderer/services/i18n.ts`、必要 Main i18n | 中英文用户反馈；不把内部协议字符串直接显示给用户 |

这些是排序/刷新职责的局部提取边界，不进行 CoworkStore 或 LibraryView 的整体拆分，也不修改生成的 vendor 输出。

### 7.2 分阶段实施

1. **共享合同与反例测试**：先实现时间/ID比较、v2 round trip、小数毫秒和 owner tie 测试，固定 §2～§3。
2. **Main 权威分页**：owner 提前至 LIMIT 前；列表/详情复用规则；同数据逐页拼接与全量排序一致；同步所有 SessionRef 构造入口。
3. **写入边界**：逐项接入 §4 矩阵，验证事务、回滚、强制 touch、子任务、Agent 级联删除和一次广播。
4. **Renderer 候选窗口**：接入协议检查、browseDepth、即时 epoch 失效、错误停止续页、合并事件与有限重试。
5. **任务分组与位置恢复**：接入连续前缀补读、虚拟行两阶段定位、超限降级及 i18n；验证预览和菜单。
6. **性能和发布**：完成 §8 的多页、事件压力及 macOS/Windows 手工验证，审查变更范围。Main/Renderer 同包交付。

测试应优先覆盖公共行为与反例，不为简单实现细节添加镜像测试。实现代码时执行相关 Vitest、changed-file ESLint、compile:electron 和 build；实际结果记录在 §10。

## 8. 验证计划

### 8.1 功能与数据场景

| Given / When | Then |
| --- | --- |
| 新任务的文件 mtime 比旧任务文件早 | 新任务组在前；同组仍按文件时间排序 |
| 同任务文件跨多个修改日期 | 一个任务组、一个任务活动日期 |
| A、B 关系时间不同，继续关系较早的 A | owner 不变，任务组按其真实时间更新 |
| A、B 关系时间相同，A.updatedAt 从较小变最大 | owner 可切到 A，列表仍只一个文件；cursor/分组失效 |
| 关系时间和任务时间都相同 | 按 sessionId，再按文件时间/itemId 稳定排序 |
| 任务时间含 .25/.5/.75 小数毫秒 | 查询、响应、游标 round trip 保留原值，多页无重复/遗漏 |
| owner 被删或 Agent 级联删除任务 | 一次通知，正确回退；最后关系消失则隐藏，真实文件/收藏保留 |
| 文件外部修改、missing、permission_denied | 既有资格规则不变，仅文件时间不改变任务组主位置 |
| 搜索/类型/favoritesOnly 组合查询 | 分页前筛选，counts 为文件数，无空任务组 |
| 旧 Main、旧游标或损坏协议 | 按 §6 报错/一次清游标，不假装排序成功、不循环续页 |

Main 测试页大小覆盖 1、24、25、100，记录数覆盖 0、24、25、48、49、120；稳定数据库下任意分页拼接严格等于全量结果，覆盖非 ASCII ID 与无效时间错误。

### 8.2 写入与事务测试

§4.1 的每个入口至少有一个通知覆盖用例，另覆盖：

- 相同状态且无投影实值变化不发；相同状态但改标题或强制 touch 按真实差异发。
- assistant/tool 消息无 touch 不发；定时投递后的显式 touch 发。
- 子任务 upsert 既有记录保留 now 写入，真实变化发；不可按重复 running 抑制。
- 用户插入到消息前与 fallback addMessage 合计只发一次。
- 历史同步较旧用户时间不发，较新小数时间推进时发。
- resetRunningSessions 批量去重；无受影响行不发。
- 嵌套事务提交后才发，回滚不发，同事务恢复原值不发，监听器异常不影响已提交结果。
- 单删/批删/Agent 删除/同 ID Agent 孤儿清理无遗漏，旧 handler 不再双发。

### 8.3 刷新与滚动反例测试

1. 原 48 条，C 的 120 条前移，原第 36 个锚点进入第 156 位：额外两页内恢复，展示完整连续前缀，游标来自新末项。
2. 同场景 C 有 1,000 条：补读不超过 200 条/两次，不拼接孤立锚点；无邻项时按像素夹取并提示位置变化。
3. 连续多次任务前移：自动补读不增加 browseDepth；正常浏览续页成功才更新基线。
4. 锚点已在结果数组、但不在挂载 DOM：通过 rowIndex 先挂载，再最多两次校正；列表/网格均通过。
5. 用户在请求或恢复中继续滚动、切换视图/查询、resize：旧 token 不夺回控制，使用当前列数与当前位置。
6. 100 个事件在 300ms 到达：一个逻辑刷新；刷新中再到事件使候选失效，最多一次即时尾随。
7. 持续写入使两轮候选失效：保留快照、禁旧 append、等待稳定期；停止写入后收敛，不无限循环。
8. append 与会话/文件/收藏/删除事件并发：旧响应不能覆盖新代次，分组和新游标一致。
9. 基础窗口读取超时或失败：不截短提交，保留旧内容；用户主动刷新可回到首页恢复。
10. 额外补读超预算：基础窗口可以成功提交并降级；预算与基础失败不能混淆。
11. 有 hasMore 但 cursor 不前进/缺失或无新增 ID：终止错误；不反复请求首页。
12. 普通收藏乐观更新；favoritesOnly 成员改变及缺失/归属变化重建分页边界。
13. 页面隐藏、重进、使用过期本地快照：当前查询校验一次；云端不受影响。
14. 打开预览后重排且目标超出列表前缀：预览仍可按 ID 刷新，列表不插入孤立项。
15. 恢复或降级后 sentinel 已位于阈值内：无新用户向下浏览动作时不自动 append、不增加 browseDepth；程序滚动不取消自己的恢复 token，真实输入可取消。
16. 次页同时包含一个已出现 ID 和一个新 ID，或跨页首尾元组逆序：废弃候选并有界重读，不静默去重；单页乱序/重复按数据合同错误处理。

### 8.4 性能与手工门槛

所有阈值是待测的发布目标，不是已完成的性能结论。用真实客户端 SQLite runtime 测量，保存机器、系统、数据规模、查询计划和 P50/P95。外部 SQLite 内存实验仅验证语义，不能替代客户端压测。

| 数据/操作 | 发布要求 |
| --- | --- |
| 1,000 文件、平均 2 关系、首页 24 | SQLite 查询 P95 < 150ms |
| 10,000 文件、平均 2 关系、首页 24 | SQLite 查询 P95 < 300ms；保存 EXPLAIN QUERY PLAN |
| 10,000 文件下刷新 120 条、含协议/hydrate/分组 | 基础窗口端到端 P95 < 1,000ms，不出现整页骨架 |
| 同规模刷新 1,000 条 | 基础窗口端到端 P95 < 2,000ms；不足则先优化查询/批量补齐，不能放大软预算掩盖 |
| 已主动加载 10,000 条再后台变化 | 每次仍 ≤100；按软预算停止，旧快照可交互、无 tight retry；明确记录自动刷新无法完成的情况 |
| 120/1,000 文件大任务前移 | 基础读取外最多 2 次/200 条，读页数不因恢复 DOM 失败而增加 |
| 同一文件 100 关系及混合搜索/收藏过滤 | owner 正确，无逐文件 N+1 查询 |
| 持续产生事件 30 秒，随后静默观察 5 秒 | 请求数与重试满足 §5，静默后可收敛，不积累无界队列 |

记录整个窗口的查询次数、总耗时、Main 单次阻塞时长、Renderer 长任务、锚点成功率/降级次数、无效候选次数。Main 使用同步 SQLite，不能仅凭 Renderer 没卡顿就判定无阻塞。

macOS 与 Windows 分别验证列表/网格、长任务组、分类搜索收藏、开着预览重排、连续滚动期间后台更新、Agent 删除，以及 Windows 100%/125%/150% 缩放。性能不达标先分析临时排序、重复关系读取和 counts 成本，再评审索引；不直接物化 owner 字段。

## 9. 验收清单

- [ ] 本地全局顺序采用任务 updatedAt/createdAt/sessionId，再到文件 sortTime/itemId，SQL 与 Renderer 同序。
- [ ] 相同任务跨日期、跨页只一个组头；日期和组头用任务时间，文件展示继续用文件时间。
- [ ] owner 保持既有规则；关系时间不同时不被纯聊天改变，相同时允许会话时间兜底切换。
- [ ] 小数毫秒历史数据可直接读取和续页，数值全链路原样往返，无时间取整迁移。
- [ ] 有效关系、missing/权限、搜索分类收藏、文件计数与删除后回退语义保持。
- [ ] 全部会话写入口与删除入口在最外层提交后准确通知；无双发、回滚误发或强制 touch 漏发。
- [ ] 事件即刻使相关旧 cursor/请求失效，多页候选一次提交；稳定后收敛，不声称跨 IPC 快照。
- [ ] browseDepth 与自动锚点补读分离，额外 200 条/两次及软耗时预算有效。
- [ ] 预算内目标使用虚拟行定位恢复；超限、目标消失及用户继续滚动按明确规则降级，不假承诺固定位置。
- [ ] 失败或未完成基础窗口不提交短窗、不用旧游标 append；显式首页刷新可恢复。
- [ ] 首页检查协议，混版本提示重启；旧 cursor 仅重试一次，缺字段不按关系时间伪造。
- [ ] 本地重排不影响云端接口、排序或缓存，Main/Preload/Renderer 同包发布，无用户文件或数据库数据迁移。
- [ ] 中英文文案、相关 Vitest、changed-file ESLint、compile:electron、build 及手工验证通过。
- [ ] 首页与多页窗口性能记录齐全；预算降级、持续写入和大任务锚点反例均有验证结果。

以上清单作为完整发布验收门禁保留；§10 记录已完成的实施和自动化检查，未完成的人工及性能验收不提前勾选。

## 10. 实施与验证记录（2026-09-07）

### 10.1 已落地范围

- Main 在 LIMIT 前选择 owner，采用五字段任务优先分页；v2 游标、完整任务时间字段、精确小数及 BINARY 比较、结构化错误已接入。未做表结构、索引策略版本或历史数据迁移。
- CoworkStore 使用同步 `runSessionTransaction` 与提交后投影日志；全部写入矩阵及 Agent 级联删除已覆盖。Main 统一订阅/退出释放，删除旧广播来源，Preload 沿用共享通道。
- Renderer 已接入任务分组、协议检查、立即失效、连续前缀候选、共享重试额度、静默退避和手动首页刷新。手动意图跨重试保留，旧请求不能消耗新手动批次额度。
- 位置恢复使用 `useLibraryScrollAnchor.ts`、`libraryScrollAnchor.ts` 和虚拟行映射。补读遵守 200 条/两次/软时间预算；程序滚动不算用户输入；仅切换列表/网格不重新启用被抑制的自动续页。
- TanStack 的异步索引定位在进入像素校正或取消时切换为固定 offset，防止后续索引跟踪覆盖用户位置；两次校正额度按恢复 ID 计数，resize 不重置额度。
- Favorite 事件新增可选 itemKind，用来区分本地产物与云端项。收藏写入开始即使本地旧请求失效，避免 IPC 通知到达前的竞态。
- 当前页面对本地变更采用合并后的权威窗口读取；安全定向合并的纯逻辑和测试已更新，但页面未启用该可选优化。这是保守读取策略，不扩大自动补读预算；大窗口超时仍走显式首页刷新降级。
- 更新文件范围仍仅为本客户端；未更改 endpoints、远端服务、OpenClaw Runtime 或生成的 vendor 内容，未创建 commit。

### 10.2 自动化与构建

验证使用 Node.js 24.17.0；系统默认 Node 22 和当前 Homebrew 路径实际指向的 Node 25 未用于验收。

| 检查 | 结果 |
| --- | --- |
| 资料库、共享排序、会话通知及 Renderer 相关测试 | 通过；覆盖 SQL → Renderer 的真实内存库集成、分页中途事件、旧手动批次和新重试额度 |
| 全量 Vitest，`npm test -- --maxWorkers=4` | 412 个文件通过，4,083 项通过，2 项跳过 |
| 改动 TS/TSX 文件 ESLint，零警告门槛 | 通过 |
| `npm run build` | 通过；保留现有 Browserslist、动态/静态混合导入等构建告警，未扩大清理范围 |
| `npm run compile:electron` | 通过，含原生依赖的 Electron 目标构建步骤 |
| Diff 空白及变更范围检查 | 通过，无用户数据、运行时打包产物或无关功能修改 |

全量测试首次在受限环境中因本地 listen 权限、npm 全局缓存写权限和 macOS `/var` / `/private/var` 路径差异失败。最终使用独立临时 npm 缓存、`TMPDIR=/private/tmp` 并允许测试回环端口；没有修改全局缓存权限。默认高并发下曾出现一次未改动的 config 测试失败，该文件连续两次单独通过，随后全量以 4 个 worker 通过。未为这些问题修改无关业务代码。

### 10.3 浏览器与性能验证边界

隔离的 headless Chrome 使用真实任务分组、滚动 hook 和虚拟列表组件，配合合成数据及基础布局 CSS，不连接用户数据：

- 列表和三列网格的 48 → 168 条任务重排，120 条前移后，先确认旧目标不在挂载 DOM，再通过虚拟行找回。
- 列表锚点偏移 -5px、网格锚点偏移 -195px 在恢复前后保持一致；恢复后 appendArmed 为 false。
- 恢复中的用户滚动可以取消旧恢复并重新启用正常浏览续页；位置 600px 在 5.5 秒后仍保持。正常恢复也观察 5.5 秒，无 TanStack 后续拉回。
- 被抑制的续页在列表/网格切换后仍保持关闭；无浏览器页面错误，测试浏览器已关闭，无测试服务器遗留。

这属于实际浏览器组件级验证，不等于完整 Electron 应用或 Windows 缩放场景人工验收。未停止已有 5175 开发服务，也未重启用户现有客户端；开发环境需要重启 Electron 以加载新 Main/Preload 协议，不能只依赖 Renderer HMR。

性能基线使用 Apple M4/macOS arm64、Node 24.17.0、仓库 better-sqlite3/SQLite 3.53.4，合成 10,000 文件、20,000 关系、100 个任务，20 个样本：

| 顺序读取窗口（含 list/counts/hydrate） | P50 | P95 |
| --- | --- | --- |
| 24 条 | 32.7ms | 38.0ms |
| 120 条 | 81.5ms | 117.3ms |
| 1,000 条 | 397.6ms | 581.0ms |

上述为 Node 中实际 SQLite 库的基线，不包含 Electron IPC、Renderer 提交及完整客户端阻塞测量，也不替代 §8.4 发布性能门槛。暂未新增索引。仍需完整客户端 macOS/Windows 人工验收、Windows 100%/125%/150% 缩放及端到端性能记录，完成后再确认发布验收清单。
