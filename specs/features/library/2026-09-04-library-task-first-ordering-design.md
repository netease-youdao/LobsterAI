# “我的文件”本地产物任务优先排序设计文档

> 创建日期：2026-09-04  
> 状态：设计完成，待实现  
> 适用仓库：`LobsterAI`  
> 产品入口：左侧栏「我的文件」→「本地产物」  
> 基线设计：`specs/features/library/2026-08-17-library-design.md`  
> 相关增量：`specs/bugfixes/library-loading-feedback/2026-08-31-library-loading-feedback-design.md`

## 0. 设计结论

本次把本地产物从“文件最近修改优先”调整为“任务最近活动优先”。用户先看到最近活动的任务，再看到该任务归属的产物。

最终顺序固定为：

```text
任务组：
  ownerSession.updatedAt DESC
  ownerSession.createdAt DESC
  ownerSession.sessionId DESC

任务组内的产物：
  artifact.sortTime DESC
  artifact.itemId DESC
```

其中：

- `ownerSession` 仍按现有“最新有效产物关系”规则选择，不因本次排序改动而改变；
- `ownerSession.updatedAt` 是 Cowork 任务列表使用的最近活动时间；
- `artifact.sortTime` 继续表示文件 `mtime`，不改名、不覆盖，也不冒充任务时间；
- 日期标题改为使用任务最近活动时间，一个任务只属于一个日期组；
- 任务置顶状态和 `pinOrder` 不参与本地产物排序；
- 同一物理文件仍只显示一次，并只归入一个最新有效任务；
- 本地列表仍按产物条数分页，默认每页 24 条，任务组允许跨页并在 Renderer 合并；
- SQLite 和 Renderer 对 ID 兜底键使用同一二进制/ASCII 词典序，不得使用受语言环境影响的 `localeCompare`；
- 排序和分页必须由 Main/SQLite 权威完成，不能只在 Renderer 对当前已加载文件重新排序；
- 云端分享文件、部署网站及其服务端接口、排序和游标全部不变。

本设计覆盖基线资料库 Spec 中与本地排序冲突的 FR-2、FR-5、FR-7、FR-8、6.2.2、6.3、8.6、8.7、9.2、9.4、测试和验收条款；其他资料库设计继续有效。加载过程中保留内容、静默刷新、请求代次、滚动锚点和无整页骨架等规则继续遵守加载反馈增量 Spec。

## 1. 概述

### 1.1 当前行为

当前本地产物排序链路为：

1. `LibraryIndexService` 读取本地文件的 `fs.stat().mtimeMs`；
2. `LibraryLocalStore` 将文件 `mtime` 写入 `file_mtime_ms` 和 `sort_time_ms`；
3. SQLite 按 `a.sort_time_ms DESC, a.id DESC` 截取第一页；
4. Renderer 再按 `item.sortTime DESC` 排序；
5. Renderer 先按文件 `sortTime` 的本地自然日分组，再按最新有效任务分组。

当前“日期、任务组、任务组内文件”三个层级都由文件时间驱动。任务标题只是分组标签，不是主排序实体。

例如同一天存在：

```text
任务 A：a-new.pdf  11:00
任务 A：a-old.pdf  09:00
任务 B：b.pdf      10:00
```

当前分组后可见顺序是：

```text
任务 A：a-new.pdf、a-old.pdf
任务 B：b.pdf
```

虽然 `b.pdf` 比 `a-old.pdf` 新，但任务分组会把 A 的条目保持在一起。也就是说，当前 UI 已经不是严格的全局文件时间顺序，同时任务组的位置仍取决于该组最新文件的 `mtime`。

### 1.2 问题

当前行为有四类产品问题：

1. 用户以任务为主要上下文，但列表首批数据由文件系统时间决定。最近完成的任务如果生成或引用了一个旧 `mtime` 文件，可能落到很后面。
2. 同一任务的产物分布在不同文件日期时，会在多个日期下重复出现任务组头，任务上下文被拆散。
3. 复制、恢复、构建缓存、外部编辑器或异常系统时钟可能改变文件 `mtime`，进而改变整个任务组位置。
4. 只改 Renderer 顺序无法修复问题，因为 SQLite 已经先按文件时间截取前 24 条；最近任务的旧文件可能根本不在已加载窗口中。

### 1.3 目标

1. 本地产物以任务为第一层排序实体，和用户查找任务的心智一致。
2. 任务组按 Cowork 任务最近活动时间稳定倒序。
3. 同一任务在当前查询结果中只出现一个组头，不再按文件日期拆组。
4. 任务组内仍按文件最后修改时间倒序，保留当前文件层级语义。
5. SQLite 查询、分页游标、Renderer 增量合并使用同一完整排序元组。
6. 会话时间或会话投影变化后，已加载窗口能静默收敛到权威顺序。
7. 保持现有一文件一条记录、最新有效任务归属、收藏、过滤、预览和文件生命周期语义。
8. 10,000 条本地索引规模下保持可接受的首屏查询和后台刷新性能。

### 1.4 非目标

| 非目标 | 说明 |
| --- | --- |
| 按任务分页 | 首期仍按产物条数分页，避免一个超大任务无界加载全部文件 |
| 展开/折叠任务组 | 本次只改变排序和分组，不增加新的交互状态 |
| 同一文件在多个任务下重复展示 | 继续使用最新有效任务作为唯一 UI 归属 |
| 改变最新有效任务选择 | 文件归属规则继续以 `lastRelatedAt` 为第一优先级 |
| 让置顶任务置顶产物 | `pinned/pinOrder` 是任务导航偏好，不进入资料库排序 |
| 改变文件 `mtime` | 文件时间仍用于组内顺序、网格元信息、预览和缩略图失效 |
| 增加用户可选排序器 | 首期直接切换默认本地排序，不增加下拉选项 |
| 修改云端资料排序 | 云端分享和网站继续按既有 `sortTime` 扁平排序 |
| 新增 SQLite 冗余列 | 首版实时关联 `cowork_sessions`；性能不达标后再单独评审物化字段 |

## 2. 概念和时间语义

### 2.1 文件归属与任务排序必须分离

一个文件可以关联多个任务。列表仍先按以下规则选择唯一的 `ownerSession`：

```text
relation.lastRelatedAt DESC
session.updatedAt DESC
session.sessionId DESC
```

该规则回答“这个文件当前归入哪个任务”。本次新增的任务排序规则回答“这些任务组以什么顺序展示”。两者不能混为一条排序：

- 正常情况下，某个历史任务最近被继续聊天不会仅因此抢走另一个任务已经拥有的文件归属；只有两条关系的 `lastRelatedAt` 完全相同时，才会触发现有 session 时间兜底；
- 某个任务确实产生、修改或引用该文件时，`lastRelatedAt` 更新，文件才可能切换归属；
- 最新关系任务被删除后，文件回退到下一条有效关系，再按回退任务的时间重新定位。

### 2.2 任务最近活动时间

任务组主排序使用 `cowork_sessions.updated_at`。当前 Cowork 语义为：

- 新增用户消息时推进；
- 任务状态发生真实切换时推进，例如开始运行、完成或失败；
- 同步到更晚的历史用户消息时只向前推进，不倒退；
- 助手流式 delta、工具流式事件和相同状态的重复写入不推进；
- 单纯修改标题、模型或其他非活动配置默认不推进。

本次只消费这个既有语义，不重新定义 Cowork 任务排序时间。这样本地产物任务组与任务列表的“最近活动”概念一致，同时避免流式输出期间持续跳动。

### 2.3 排序字段定义

| 名称 | 数据来源 | 用途 | 是否可变 |
| --- | --- | --- | --- |
| `sessionUpdatedAt` | `cowork_sessions.updated_at` | 任务组主顺序、日期标题、组头时间 | 是 |
| `sessionCreatedAt` | `cowork_sessions.created_at` | 相同活动时间的第二稳定键 | 否 |
| `sessionId` | `cowork_sessions.id` | 任务组最终稳定键 | 否 |
| `artifactSortTime` | `library_local_artifacts.sort_time_ms` | 任务组内文件顺序 | 是 |
| `itemId` | `library_local_artifacts.id` | 文件最终稳定键 | 否 |
| `lastRelatedAt` | `library_artifact_sessions.last_related_at` | 选择文件唯一归属任务 | 是 |

不得把 `sessionUpdatedAt` 写入 `artifact.sortTime`。`sortTime` 已经被预览时间、网格卡片、文件变化和缩略图缓存使用，继续保持文件时间语义。

### 2.4 权威排序元组

对一个已经解析出唯一 `ownerSession` 的本地产物，定义：

```ts
type LibraryLocalOrderKey = readonly [
  sessionUpdatedAt: number,
  sessionCreatedAt: number,
  sessionId: string,
  artifactSortTime: number,
  itemId: string,
];
```

全部字段按降序比较。`sessionId` 必须位于文件时间之前；否则两个任务的文件仍可能交错，无法形成连续任务组。

当前新建 session 和 artifact ID 均由 UUID 生成；为兼容历史数据，排序合同只要求它们是有长度上限的 ASCII 稳定标识，不要求严格匹配 UUID 形状。SQL 的 ID 比较使用 SQLite `BINARY` collation；Renderer 使用直接关系比较复现相同顺序，不得使用 `localeCompare`：

```ts
const compareAsciiIdDesc = (left: string, right: string): number => {
  if (left === right) return 0;
  return left > right ? -1 : 1;
};
```

若未来 ID 来源允许非 ASCII 字符，必须同时升级 SQL 与 Renderer 的字节序合同，不能只替换一端的比较器。

### 2.5 日期和任务组

Renderer 的层级调整为：

```text
先按 ownerSession 聚合文件
  → 按任务排序元组排序任务组
  → 按 sessionUpdatedAt 的本地自然日聚合任务组
  → 在每个任务组内按文件排序元组排序产物
```

显示规则：

- 一级日期使用 `sessionUpdatedAt` 的本地自然日；
- 今天、昨天和跨年格式沿用现有文案及本地化逻辑；
- 任务组头右侧显示 `sessionUpdatedAt` 的时分；
- 列表行继续不重复显示时间；
- 网格卡片继续显示文件 `artifact.sortTime`；
- 预览标题栏继续显示文件最后修改时间；
- 一个任务只进入一个日期组；
- 一个任务跨页加载时追加到已有任务组，不生成第二个组头。

### 2.6 搜索、分类、收藏和计数

搜索、分类和收藏先决定哪些文件有资格进入结果集，再对结果集执行任务优先排序：

- 搜索规则仍只匹配现有文件名和扩展名字段；
- 分类仍按文件类型过滤；
- “我的收藏”仍按文件收藏过滤，不收藏任务；
- 一个任务没有任何匹配文件时不显示空组头；
- 一个任务只有部分文件匹配时只显示匹配文件，但组位置仍由任务时间决定；
- `counts` 继续统计文件数，不改为任务数；
- 缺失文件、无有效任务关系及权限状态的现有可见性规则不在本次改变。

## 3. 用户场景

### 场景 1：最近任务使用旧文件

**Given** 任务 A 今天完成并关联一个 `mtime` 为上周的文件，任务 B 昨天完成并关联一个今天刚修改的文件。  
**When** 用户进入「本地产物」。  
**Then** 任务 A 排在任务 B 前面；A、B 组内各自仍按文件 `mtime` 排序。

### 场景 2：同一任务的文件跨多个修改日期

**Given** 一个任务包含今天、昨天和上周修改的多个产物。  
**When** 列表完成加载。  
**Then** 该任务只在任务最近活动日期下显示一个任务组，所有已加载产物位于同一组内。

### 场景 3：继续已有任务但没有生成新文件

**Given** 一个已有产物的旧任务收到新用户消息并开始运行，但本轮尚未产生新文件。  
**When** `cowork_sessions.updated_at` 真正推进。  
**Then** 该任务组按新的活动时间移动到正确位置；文件归属和文件 `mtime` 不变。

### 场景 4：外部编辑文件

**Given** 用户在系统编辑器中修改某任务的一个产物。  
**When** watcher 更新文件 `mtime`。  
**Then** 文件只在所属任务组内部移动；整个任务组不会因为外部文件修改而压过最近活动任务。

### 场景 5：同一文件关联多个任务

**Given** 任务 A 创建文件，任务 B 后续明确修改同一路径。  
**When** 用户查看本地产物。  
**Then** 文件只显示一次并归入 B；A、B 的全部关系继续保存在 SQLite。继续 A 的纯文本对话不会把文件从 B 抢回 A。

### 场景 6：删除当前归属任务

**Given** 文件当前归入任务 C，并仍有关联任务 A、B。  
**When** 用户删除 C。  
**Then** 文件按既有关系规则回退到 B，并按 B 的活动时间重新定位；真实文件和收藏不删除。

### 场景 7：一个任务超过一页

**Given** 最近任务包含 120 个符合筛选的产物，页大小为 24。  
**When** 首次加载和自动续页依次完成。  
**Then** 前五页均可由该任务占据；Renderer 始终只按 `sessionId` 渲染一个任务组头，下一任务在该组耗尽后出现，单次响应仍受页大小约束。

### 场景 8：后台任务改变顺序

**Given** 用户停留在本地产物列表中部，另一个已有产物的 IM、定时或后台任务更新时间推进。  
**When** Main 发出会话投影变化事件。  
**Then** Renderer 静默重读已加载窗口，列表顺序收敛；不出现整页骨架，当前可见条目和已打开预览保持稳定。

### 场景 9：相同时间戳

**Given** 多个任务拥有相同毫秒级 `updatedAt`，同一任务多个文件也拥有相同 `mtime`。  
**When** 用户跨页加载并刷新。  
**Then** 使用 `createdAt/sessionId/itemId` 完成确定性排序，不重复、不漏项，刷新前后顺序一致。

## 4. 功能需求

### FR-1：任务优先顺序

1. 本地产物页的第一排序实体必须是文件当前归属的有效任务。
2. 任务按 `updatedAt DESC, createdAt DESC, sessionId DESC` 排序。
3. 不把 `pinned` 或 `pinOrder` 纳入排序。
4. 同一任务的所有当前结果必须连续，不允许与其他任务的文件交错。
5. 云端资料不使用该规则。

### FR-2：任务内文件顺序

1. 同一任务内按 `artifact.sortTime DESC, itemId DESC` 排序。
2. 文件被 watcher 检测到修改时，只重新计算文件在当前任务组内的位置。
3. 文件时间异常或位于未来不会改变任务组之间的顺序。
4. `sortTime` 的显示、预览和缩略图语义保持文件最后修改时间。

### FR-3：唯一任务归属

1. 文件的唯一任务归属继续按 `lastRelatedAt DESC, session.updatedAt DESC, sessionId DESC` 选择。
2. 会话 `updatedAt` 只在 `lastRelatedAt` 相同时参与归属兜底；不得把“最近聊天任务”直接当作文件所有者。
3. 删除任务时保留现有回退规则。
4. 本次不把一个文件复制到多个任务组。

### FR-4：日期和任务组头

1. 日期标题基于任务 `updatedAt`，不是文件 `sortTime`。
2. 一个任务只能属于一个日期组。
3. 任务组头显示任务标题和任务 `updatedAt` 的时分。
4. 同一任务跨页追加时合并现有组头。
5. Renderer 收到同一 `sessionId` 的不一致会话时间时，使用最大有效 `updatedAt` 形成单一组，并触发权威刷新；不得拆成两个日期组。

### FR-5：权威分页

1. Main 必须在 `ORDER BY` 和 `LIMIT` 之前解析每个文件的唯一归属任务。
2. SQLite 按完整五字段排序元组分页。
3. 首次读取仍为 24 个文件，最大页大小仍为 100。
4. 任务可跨页，但一个页面响应中的文件顺序必须与全量查询前缀一致。
5. 页大小和 `counts` 始终按产物条数计算，不按任务组数计算；不得为了返回完整任务组而执行无界读取。
6. Renderer 继续按 `itemKind:itemId` 去重追加，并按 `sessionId` 合并跨页任务组头。
7. 查询条件变化、排序模式变化或游标版本变化时从第一页开始。

### FR-6：会话投影变化

以下任一字段在 SQLite 提交后实际变化，都可能影响本地产物任务组，必须产生 Main 内部的会话投影变化通知：

- `cowork_sessions.updated_at`；
- `cowork_sessions.title`；
- `cowork_sessions.agent_id`。

`created_at` 和 `id` 不可变，不需要更新通知。任务删除继续使用 `session_deleted` 语义，但所有删除入口必须共用同一个提交后通知边界。

现有 `cowork:sessions:changed` 不能作为本功能的正确性来源：它主要覆盖 OpenClaw channel、历史同步和部分 reconcile 路径，并不保证每次 Cowork `updated_at` 写入都发送；同时它也可能在排序字段没有变化时发送。实现必须在 `CoworkStore` 的持久化提交边界产生准确通知，再由 Main 转换成 Library 变更事件。

当前普通单删和批删由 `main.ts` 取得 `affectedArtifactIds` 后发送 Library 事件，但 Agent 删除通过 `AgentManager.deleteAgent → CoworkStore.deleteSessionsForAgent` 只向上返回布尔值，已打开的资料库可能收不到级联任务删除影响。实现必须补齐该入口：优先由 CoworkStore 提交后删除通知携带去重后的 `sessionIds/affectedArtifactIds`；如果无法携带 ID，则至少发送一次无 ID 的 `session_deleted` 权威刷新。不得同时保留调用方手工广播而造成重复事件。

### FR-7：静默权威刷新

1. 会话投影变化会改变同一任务全部产物的主排序键，不能只对当前已加载 `itemIds` 做定向 merge。
2. 当前窗口仍有后续页时，任一已加载项的五字段排序键、owner 或可见性改变，以及任一新项将插入当前窗口，都必须重建权威窗口和 `nextCursor`；不得只重排当前数组后沿用旧游标。
3. Renderer 收到需要权威刷新的事件后使当前本地 `nextCursor` 和 append generation 失效，静默重读当前已加载窗口。
4. 重读目标为刷新前已加载文件数，且至少为默认页大小；除权威来源耗尽外不得缩短已加载窗口，每次 IPC 请求仍不超过 100 条。
5. 事件继续使用现有 300ms 静默窗口、1,000ms 最大等待、单执行中和单尾随批次约束。
6. 会话投影变化可能影响任意本地筛选快照：当前可见查询执行一次刷新，其余缓存的本地 `queryKey` 标记 dirty；页面隐藏时不请求，返回或切换到相应查询时各自校验一次。
7. 刷新保留已有内容、筛选、预览、菜单和滚动位置，不进入首次加载骨架。
8. 若滚动位置接近顶部，保持 `scrollTop = 0` 以展示新的最近任务；否则优先保持首个可见文件的视觉锚点。

### FR-8：兼容和回退

1. 新本地游标使用版本 2，并绑定任务优先排序模式。
2. 旧版本 1 游标不迁移；收到游标版本或排序模式不匹配时，Renderer 清除游标并重新请求第一页。
3. 游标只存在页面内存，不需要数据库迁移。
4. 新 Renderer 在开发 HMR 期间收到缺少任务时间字段的旧 Main 响应时，使用 `lastRelatedAt` 形成临时任务组并要求刷新；正式打包版本必须返回完整字段。
5. 排序上线失败时可恢复文件优先查询；由于没有数据重写或 DDL，回滚不会损坏索引。

## 5. Main 与 SQLite 设计

### 5.1 查询不变量

必须遵守以下顺序：

```text
应用本地产物可见性条件
  → 应用分类、关键词、收藏条件
  → 为每个文件选择唯一 ownerSession
  → 计算五字段排序元组
  → 应用 v2 游标谓词
  → ORDER BY 完整元组
  → LIMIT pageSize + 1
```

禁止继续采用“先按文件 `mtime` 取 24 条，再 hydrate 这些文件的任务并在 Renderer 重排”。该做法无法返回真正的任务优先全局前缀。

### 5.2 推荐查询形态

客户端 SQLite 可使用窗口函数一次完成当前过滤结果的唯一任务选择。逻辑形态如下，最终实现可以根据 `EXPLAIN QUERY PLAN` 调整 CTE 边界，但不得改变排序合同：

```sql
WITH filtered_artifacts AS (
  SELECT a.*
  FROM library_local_artifacts a
  WHERE a.availability <> :missing
    AND EXISTS (
      SELECT 1
      FROM library_artifact_sessions visible_relation
      JOIN cowork_sessions visible_session
        ON visible_session.id = visible_relation.session_id
      WHERE visible_relation.artifact_id = a.id
    )
    -- category / keyword / favorites 条件在这里追加
),
ranked_relations AS (
  SELECT
    fa.id AS artifact_id,
    r.session_id,
    r.last_related_at,
    r.last_message_id,
    r.session_artifact_id,
    s.title AS session_title,
    COALESCE(NULLIF(TRIM(s.agent_id), ''), 'main') AS session_agent_id,
    s.created_at AS session_created_at,
    s.updated_at AS session_updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY fa.id
      ORDER BY
        r.last_related_at DESC,
        s.updated_at DESC,
        r.session_id COLLATE BINARY DESC
    ) AS relation_rank
  FROM filtered_artifacts fa
  JOIN library_artifact_sessions r ON r.artifact_id = fa.id
  JOIN cowork_sessions s ON s.id = r.session_id
),
ordered_items AS (
  SELECT
    fa.*,
    rr.session_id,
    rr.last_related_at,
    rr.last_message_id,
    rr.session_artifact_id,
    rr.session_title,
    rr.session_agent_id,
    rr.session_created_at,
    rr.session_updated_at
  FROM filtered_artifacts fa
  JOIN ranked_relations rr
    ON rr.artifact_id = fa.id
   AND rr.relation_rank = 1
)
SELECT *
FROM ordered_items
WHERE
  -- 首页没有此段；续页追加 5 字段显式词典序谓词
ORDER BY
  session_updated_at DESC,
  session_created_at DESC,
  session_id COLLATE BINARY DESC,
  sort_time_ms DESC,
  id COLLATE BINARY DESC
LIMIT :page_size_plus_one;
```

实现要求：

- 可见性和筛选必须在排名、游标和 `LIMIT` 前生效；
- 最新任务规则必须保持基线的三个排序字段，不能误用任务组排序规则选择 owner；
- owner 选择在 `LibraryLocalStore` 内只保留一个权威实现，并由列表、`getLocalItems` 和详情投影复用；不得让分页查询与 hydrate 各自演进出不同规则；
- 列表响应直接携带当前 owner 会话投影，避免再为每张卡查询一次；
- 完整关系数量和详情仍可以按当前页 `artifact_id` 批量读取；
- `LIMIT pageSize + 1` 继续判断 `hasMore`；
- 查询失败不得回退为 Renderer 当前页猜测排序。

### 5.3 v2 游标

任务优先游标编码前的 JSON：

```json
{
  "version": 2,
  "sort": "recent_task",
  "sessionUpdatedAt": 1788470400000,
  "sessionCreatedAt": 1788460000000,
  "sessionId": "session-uuid",
  "artifactSortTime": 1788400000000,
  "itemId": "artifact-uuid"
}
```

继续使用 base64url 编码，使 Renderer 将游标当作不透明字符串。解码必须校验：

- `version === 2`；
- `sort === LibraryLocalSort.RecentTask`；
- 三个时间字段为有限安全整数；
- ID 为 1～256 个可打印 ASCII 字符（`U+0021`～`U+007E`）；为兼容历史数据不强制 UUID 形状；
- 游标排序模式和当前请求一致。

五字段全部降序，因此续页条件等价于：

```sql
WHERE
  session_updated_at < :session_updated_at
  OR (
    session_updated_at = :session_updated_at
    AND session_created_at < :session_created_at
  )
  OR (
    session_updated_at = :session_updated_at
    AND session_created_at = :session_created_at
    AND session_id COLLATE BINARY < :session_id
  )
  OR (
    session_updated_at = :session_updated_at
    AND session_created_at = :session_created_at
    AND session_id COLLATE BINARY = :session_id
    AND sort_time_ms < :artifact_sort_time
  )
  OR (
    session_updated_at = :session_updated_at
    AND session_created_at = :session_created_at
    AND session_id COLLATE BINARY = :session_id
    AND sort_time_ms = :artifact_sort_time
    AND id COLLATE BINARY < :item_id
  )
```

最后一条实际返回记录生成下一页游标。不得用任务组最大文件时间代替 `sessionUpdatedAt`，也不得省略 `sessionId` 或 `itemId`。

### 5.4 可变排序键和分页一致性

`sessionUpdatedAt` 与 `artifactSortTime` 都可能在两次分页请求之间变化。首期采用最终一致、主动失效策略：

1. 会话投影变化始终使整个本地窗口游标失效，并从第一页静默重读；
2. 窗口仍有后续页时，已加载文件的 `sortTime`、owner 或可见性变化同样使游标失效；
3. 新记录或未加载文件变化后，若其新排序键位于当前末项之前，则使窗口失效；位于末项之后时可以保留当前窗口；
4. `favoritesOnly` 查询中的收藏变化属于可见性变化，窗口仍有后续页时必须刷新；普通查询中的收藏布尔值可继续乐观定向更新；
5. 已经完整加载全部结果时，可以按稳定 ID 定向合并并使用完整比较器重排，因为不存在后续页游标；
6. 刷新进行中的旧 append 响应通过 generation/requestId 丢弃；
7. 重读覆盖刷新前已加载条数，不能只缩回 24 条；
8. 重读完成后用新结果末尾生成新的 v2 游标；
9. 并发变化再形成一个尾随刷新，不创建无界请求队列。

该方案不提供跨多次 IPC 请求的数据库快照，但事件失效和权威重读能够收敛。稳定 ID 去重只能防止重复显示，不能替代游标失效，因为排序键前移可能造成未加载文件被跳过。

### 5.5 计数和展示资格

本次不改变计数定义：

- `counts.total/available/missing` 继续按文件计数；
- 至少有一个仍存在任务关系的谓词必须先于筛选和计数；
- 正常列表继续排除 `missing`；
- `permission_denied` 等现有非 missing 状态保持当前行为；
- 删除最后一个任务关系后文件立即退出所有本地产物查询；
- 收藏记录和内部索引仍保留。

### 5.6 性能和索引策略

首版不在 `library_local_artifacts` 冗余：

- `owner_session_id`；
- `owner_session_updated_at`；
- `owner_session_created_at`。

理由是 owner 会随关系创建、任务删除和关系回退变化，而 session 时间又会独立变化。冗余字段需要多入口同步和修复迁移，失效风险高于当前收益。

现有关系索引：

```sql
library_artifact_sessions(artifact_id, last_related_at DESC, session_id DESC)
library_artifact_sessions(session_id, last_related_at DESC)
```

先用现有索引实现查询并执行 `EXPLAIN QUERY PLAN`。只有在 1,000/10,000 条数据集证明任务时间连接或排序成为瓶颈时，才单独评审：

1. 评审是否增加 `cowork_sessions(updated_at DESC, created_at DESC, id DESC)` 辅助排序索引，并用查询计划证明它确实被消费；
2. 改写为从有产物关系的 session 顺序驱动查询；
3. 最后才考虑物化 owner 投影及一致性修复。

不能在没有基准数据的情况下直接加入冗余列或触发器。

## 6. 共享类型、排序常量和 IPC

### 6.1 排序常量

新增明确的本地排序常量，不继续用含糊的 `RecentlyUpdated` 表示两种来源：

```ts
export const LibraryLocalSort = {
  RecentTask: 'recent_task',
} as const;
export type LibraryLocalSort = typeof LibraryLocalSort[keyof typeof LibraryLocalSort];
```

云端继续使用现有 `LibrarySort.RecentlyUpdated`。本地产物 UI 首期不显示排序选择器，但 `LibraryLocalListOptions.sort` 默认并只接受 `RecentTask`，为游标校验和未来扩展保留明确协议。

### 6.2 会话投影

`LibrarySessionRef` 增加任务时间：

```ts
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
```

新 Main 对本地列表和本地详情必须返回完整字段。云端项在本机成功解析到相关任务时也复用完整投影；无法解析时仍不提供 `latestSession`。

Renderer 的运行时边界仍校验时间是有限安全整数。开发 HMR 连接旧 Main 时可临时回退：

```text
updatedAt 缺失 → 使用同一 session 已加载项的最大 lastRelatedAt
createdAt 缺失 → 回退 updatedAt
```

这个回退只保证页面可用，不是正式排序合同。

### 6.3 列表选项

```ts
interface LibraryLocalListOptions {
  category?: LibraryCategory;
  keyword?: string;
  cursor?: string;
  pageSize?: number;
  sort?: LibraryLocalSort;
  favoritesOnly?: boolean;
}
```

Main 对省略 `sort` 的请求按 `RecentTask` 处理。非法排序或与游标不一致时返回集中定义的参数错误；Renderer 对游标错误只允许自动清游标重试一次，避免无限重试。

### 6.4 会话投影变化事件

新增共享原因值：

```ts
export const LibraryChangeReason = {
  // existing values...
  SessionProjectionChanged: 'session_projection_changed',
} as const;

interface LibraryChangedPayload {
  reason: LibraryChangeReason;
  itemIds?: string[];
  sessionIds?: string[];
}
```

事件合同：

- `session_projection_changed` 必须携带去重后的 `sessionIds`，不携带路径、标题或消息内容；
- 它是“排序窗口可能整体失效”的信号，不是定向文件更新；
- Renderer 将其标记为 `requiresAuthoritativeRefresh`；
- Main 可以在发送前批量确认这些 session 至少存在一条资料关系，减少无产物任务造成的无效刷新；
- 即使无法执行该优化，也不能漏发真实投影变化；
- 删除仍使用 `session_deleted`，不为同一删除重复发送 projection 事件。

### 6.5 CoworkStore 提交后通知

在 `CoworkStore` 内集中处理会话投影和删除通知，而不是让各调用方猜测 SQL 是否改变了 `updated_at`、或某条删除路径是否级联移除了任务：

```ts
export const CoworkSessionProjectionField = {
  UpdatedAt: 'updatedAt',
  Title: 'title',
  AgentId: 'agentId',
} as const;
type CoworkSessionProjectionField =
  typeof CoworkSessionProjectionField[keyof typeof CoworkSessionProjectionField];

interface CoworkSessionProjectionChange {
  sessionId: string;
  changedFields: CoworkSessionProjectionField[];
}

subscribeSessionProjectionChanges(
  listener: (change: CoworkSessionProjectionChange) => void,
): () => void;

interface CoworkSessionDeletion {
  sessionIds: string[];
  affectedArtifactIds: string[];
}

subscribeSessionDeletions(
  listener: (deletion: CoworkSessionDeletion) => void,
): () => void;
```

实现要求：

1. 通知只在 SQLite 写入成功并提交后发出；
2. 值未实际变化时不发出；
3. 事务内发生多次写时合并字段，提交后每个 session 至多一次；
4. `addMessage` 的 assistant/tool 消息不触发，因为它们不推进 `updated_at`；
5. 相同状态的 `updateSession` 不触发；
6. 标题或 agent 变化触发投影刷新，但不人为推进 `updated_at`；
7. `replaceConversationMessages/replaceSessionMessages` 只有在更晚用户消息实际推进时间时触发；
8. 监听器异常只记录警告，不回滚 Cowork 数据写入；
9. 应用退出或 Library 服务销毁时解除订阅。
10. `deleteSession`、`deleteSessions`、`deleteAgent` 和创建同 ID Agent 时的孤儿清理都在各自最外层事务提交后发送一次删除通知。
11. 删除通知携带事务内去重的 `sessionIds/affectedArtifactIds`；无受影响文件时可以不发 Library 事件。
12. 迁移完成后，单删/批删 IPC handler 不再额外手工广播同一 `session_deleted`，保证每次提交只有一个来源。

实现时可在大型 `CoworkStore` 中先提取一个小型私有 `touchSessionProjection`/`publishCommittedProjectionChange` 辅助边界，避免在每个调用点复制事件判断；本次不进行无关的 CoworkStore 文件拆分。

## 7. Renderer 设计

### 7.1 纯分组模块

不要继续把任务优先算法堆进大型 `LibraryView.tsx`。新增或演进一个纯 TypeScript 模块，例如：

```text
src/renderer/components/library/libraryTaskGrouping.ts
```

公开最小能力：

```ts
getLibraryLocalOrderKey(item): LibraryLocalOrderKey
compareLibraryLocalItems(left, right): number
groupLibraryItemsByTaskActivity(items, locale, now): LibraryDateGroup[]
```

算法步骤：

1. 按 `latestSession.sessionId` 建立任务 Map；
2. 同一任务出现不一致的会话投影时取最大有效 `updatedAt`，并标记需要权威刷新；
3. 任务内按 `artifact.sortTime DESC, itemId DESC` 排序；
4. 任务组按 `updatedAt DESC, createdAt DESC, sessionId DESC` 排序；
5. 再按任务 `updatedAt` 的本地日期把已经排好序的任务组放入日期桶；
6. 输出给现有虚拟列表。

必须先按任务聚合、再按日期聚合。不能继续使用“逐文件先分日期、再分 session”的算法，否则不一致投影或旧响应可能把同一任务再次拆到两个日期。

### 7.2 列表和组头显示

现有 `LibraryVirtualizedGroups` 可以继续消费 `dateGroups/sessionGroups/items`，但字段语义更新：

- `sessionGroup.sortTime` 改为任务 `updatedAt`；
- 日期组代表时间也来自任务 `updatedAt`；
- `sessionGroup.items` 已按文件时间排序；
- 任务组标题点击仍打开 `latestSession`；
- 网格卡片的 `item.sortTime` 显示不变；
- 不增加文件行时间、任务状态、Agent 名称或额外元信息。

若变量继续命名为泛化的 `sortTime` 容易混淆，Renderer 内部组模型应改为 `activityTime`；不要求修改跨来源的 `LibraryItem.sortTime`。

### 7.3 增量文件变化

`libraryLocalQueryState` 的当前窗口比较器必须升级为完整五字段顺序。`recorded/file_changed/session_deleted/favorite` 先做以下安全性判定：

1. 使用权威响应中的完整 session 投影计算新键，并保留同 ID 旧记录用于比较；
2. `hasMore === false` 时，没有后续页边界，可按稳定 ID 替换、插入或删除后用完整比较器重排；
3. `hasMore === true` 时，只要已加载 item 的排序键、owner 或查询资格改变，就升级为权威窗口刷新；
4. 新 item 或原本未加载 item 的新键排在当前末项之前时，也升级为权威窗口刷新；排在当前末项之后时可留给续页；
5. `favoritesOnly` 下收藏变化按查询资格变化处理；普通查询中仅 `isFavorite` 改变可继续乐观替换；
6. 只有确认当前窗口成员、顺序和旧 `nextCursor` 都不受影响时，才允许定向 merge；
7. 安全合并后重新运行纯任务分组，不直接操作虚拟行数组。

稳定 ID 去重只解决重复渲染，不能证明游标仍然有效。尤其是已加载文件向游标之后移动时，必须让一个原未加载文件补入当前窗口；单纯在当前数组内排序会造成短窗和后续漏项。

### 7.4 会话变化刷新

`session_projection_changed` 不走 `getLocalItems(itemIds)`，因为：

- 一个 session 可能影响任意数量文件；
- 未加载文件可能整体移动到首屏；
- `updatedAt` 在 owner 选择的时间相同兜底中也可能改变归属；
- 当前 `nextCursor` 基于旧排序键，继续 append 会产生缺口。

处理流程：

```text
收到 session_projection_changed
  → RefreshCoordinator 合并 sessionIds
  → 标记 requiresAuthoritativeRefresh
  → 递增本地 append generation
  → 捕获滚动锚点
  → 从第一页按新排序重读到原已加载条数
  → 一次提交 list/counts/hasMore/nextCursor
  → 恢复锚点并丢弃旧 append 响应
```

标题变化也走同一路径，保证组头不长期显示旧标题。刷新失败时保留旧快照和旧游标但把 query 标为 dirty；下一次显式刷新、重新进入或后续成功事件重新读取，不能在失败后继续使用可能失效的旧游标自动续页。

projection change 的失效范围是所有本地查询快照，不只是事件到达时的当前类型/关键词/收藏条件。当前 query 立即走合并后的单次刷新；LRU 中其他本地 query 只标记 dirty，在成为活动查询时校验，避免一次事件并发重读所有筛选组合。云端 query cache 不受影响。

### 7.5 滚动和虚拟化

继续沿用现有虚拟化结构和 overscan。任务组整体移动时：

- `scrollTop <= 24px`：保持顶部，不恢复旧首项锚点，使用户能看到新晋最近任务；
- 列表中部：保持首个可见 `itemKind:itemId` 及相对偏移；
- 锚点文件被过滤或删除：回退到刷新前最近仍存在的相邻文件；
- 已打开预览：按 `itemId` 继续绑定权威记录，排序变化不关闭预览；
- 已打开任务组菜单或文件菜单：目标仍存在则保持，否则关闭。

### 7.6 加载反馈继承

本次继续遵守加载反馈设计：

- 冷加载、查询切换、后台刷新、手动刷新和 append 使用不同 phase；
- 会话时间重排属于后台刷新，不显示整页骨架；
- 已有内容不卸载；
- 300ms/1,000ms 合并窗口不变；
- 同时最多一个刷新和一个尾随刷新；
- append 只显示列表底部局部进度；
- 迟到响应不能覆盖当前 query 或新排序 generation。

## 8. 多任务关系和生命周期

### 8.1 一文件一条记录

本次保持 artifact-centric 数据模型：

- `path_key` 继续去重同一物理路径；
- 一个 `itemId` 只渲染一张卡或一行；
- 全部任务关系继续保存在 `library_artifact_sessions`；
- 列表只投影一个 `ownerSession`；
- 详情仍可读取全部关系，但 UI 不因此复制条目。

因此，“列出这个任务的产物”在本期精确定义为：“列出当前唯一归属于该任务的产物”，不是“列出历史上与该任务发生过任何关系的所有文件”。如果未来需要任务历史全量视图，应新增 relation-centric 查询和重复项语义，不能悄悄改变本列表的去重合同。

### 8.2 删除任务

任务删除继续在事务中删除关系并返回受影响 `artifactIds`。提交后：

- 有其他关系的文件重新选择 owner；
- 没有其他关系的文件退出可见结果；
- 受影响文件的任务排序键可能大幅变化；
- 当前查询已完整加载时，Renderer 可按受影响 ID 定向读取并重排；仍有后续页时统一执行权威窗口刷新；
- 不额外发送 `session_projection_changed`，避免重复刷新。

无 ID 的 `session_deleted` 始终执行权威窗口刷新。不得在仍有后续页时只做定向回退后继续使用旧游标。

### 8.3 文件变化

文件 `mtime` 变化只影响组内排序键。现有 watcher、reconcile、missing、permission denied、重命名和缩略图失效逻辑不变。文件变化不会修改 `cowork_sessions.updated_at`，也不会把外部编辑归因于某个新任务。

## 9. 备选方案与取舍

### 9.1 只改 Renderer 排序——拒绝

SQLite 已按文件时间截取第一页，Renderer 无法看到最近任务中落在窗口之外的旧文件。该方案会制造局部正确、全局错误的排序，并破坏续页。

### 9.2 使用 `lastRelatedAt` 排任务组——不采用为主键

优点是所有变化都来自资料事件，刷新简单；缺点是它表示“文件最后关联时间”，不是“任务最近活动时间”。用户继续一个任务但未生成新文件时，组不会移动，不符合本次目标。`lastRelatedAt` 继续用于 owner 选择和未来可选的“产物活动”排序。

### 9.3 继承任务置顶——拒绝

置顶是任务导航组织能力。把它带入资料库会让很旧的置顶任务长期压住最近任务，并使时间日期组失真。本地资料库只按任务活动时间排序。

### 9.4 按任务分页并一次返回完整任务——暂缓

任务分页能保证首屏任务组完整，但一个任务可能有数百文件，响应和缩略图队列没有自然上限，还需要组内独立分页。首期保留文件级 keyset 分页，让任务组可跨页合并。

### 9.5 在产物表冗余 owner 和任务时间——暂缓

该方案读取快，但每次任务活动、关系新增、任务删除和回退都要批量更新产物表，还需修复不一致数据。首版使用实时 join，以性能测试决定是否需要后续物化。

### 9.6 复用 `cowork:sessions:changed`——拒绝作为权威来源

该事件覆盖面和触发语义都与 `cowork_sessions` 投影提交不完全一致。可以把它作为诊断或兼容兜底，但本功能的正确性必须来自 CoworkStore 提交后的精确投影通知。

### 9.7 综合评估

| 维度 | 评估 | 主要依据与代价 |
| --- | --- | --- |
| 用户心智 | 高收益 | 用户通常记得“哪个任务产出的文件”，任务优先比全局 `mtime` 更容易定位上下文 |
| 排序正确性 | 可控 | Main 采用唯一 owner 投影和五字段 keyset 后可得到全局一致顺序；只改 Renderer 则不可接受 |
| 交互稳定性 | 中等风险 | 继续聊天或真实状态切换会让整组移动，需要静默重读和滚动锚点；顶部用户会主动看到最新任务 |
| 大任务体验 | 明确代价 | 一个 100+ 产物的最近任务可连续占据多页，但换来单次响应有界和简单可靠的文件级分页 |
| 查询性能 | 中等风险 | 会话时间成为首键后通常需要临时排序；先以 1,000/10,000 条基准决定查询改写或索引，不提前物化 |
| 实现复杂度 | 中高 | 涉及 Main 查询、游标、共享类型、CoworkStore 通知和 Renderer 窗口状态，必须作为一个排序合同原子落地 |
| 数据与回滚 | 低风险 | 基线方案不重写文件时间、不新增冗余列，失败时可恢复旧查询和旧分组 |

结论：推荐实施。它能直接修复“最近任务的旧文件首屏不可见”和“同一任务按文件日期拆组”两个核心问题；接受条件是不能把它缩减成前端排序小改，并且必须在上线前通过分页一致性、Agent 删除通知与 10,000 条查询计划门槛。

## 10. 兼容、发布和回滚

### 10.1 数据兼容

- 不新增或重写 SQLite 数据；
- 不改变 `sort_time_ms` 和 `file_mtime_ms`；
- 不重跑历史回填；
- 不改变 `LIBRARY_INDEX_POLICY_VERSION`，因为索引内容和关系识别规则不变；
- 现有数据库升级后第一次查询即可获得任务优先顺序。

### 10.2 游标兼容

- v1 `{sortTime,itemId}` 游标只存在 Renderer 内存；
- 应用升级或页面重载后自然从无游标首页开始；
- 新 Main 不把 v1 游标解释为 v2；
- 遇到版本不匹配时返回明确错误，Renderer 清游标自动重试一次；
- 日志只记录游标版本和排序模式，不记录 ID、文件名、标题或路径。

### 10.3 发布范围

本次是 Electron 客户端原子发布：Main、Preload、Renderer 和共享类型必须同版本交付。不需要 `lobsterai-server`、`lobsterai-admin`、`lobsterai-portal` 或 `docs/server-integration/2026-08-17-library-cloud-items.md` 配套发布。

### 10.4 回滚

如果任务优先查询出现不可接受的性能或分页问题：

1. 恢复本地默认文件优先查询和 v1 游标；
2. Renderer 恢复文件日期分组；
3. 保留新增的会话投影字段不会破坏旧 UI；
4. 停止 Library 对会话投影事件的订阅；
5. 无需回滚数据库或用户文件。

## 11. 涉及文件与模块边界

| 文件/模块 | 设计改动 |
| --- | --- |
| `src/shared/library/constants.ts` | 新增 `LibraryLocalSort.RecentTask`、`SessionProjectionChanged` |
| `src/shared/library/types.ts` | `LibrarySessionRef` 增加任务时间；变更 payload 增加 `sessionIds`；本地 sort 类型 |
| `src/main/library/libraryLocalStore.ts` | owner 会话投影查询、五字段排序、v2 游标、窗口读取 |
| `src/main/library/libraryIpc.ts` | 校验新排序与 v2 游标；游标错误合同 |
| `src/main/coworkStore.ts` | 集中提交后 session projection 与删除通知；不做无关拆分 |
| `src/main/main.ts` | 订阅 CoworkStore 投影/删除变化并转换为 `library:changed`；移除单删/批删的重复手工广播；退出清理 |
| `src/main/ipcHandlers/agents/handlers.ts` | 验证 Agent 级联删任务走统一删除通知，不再遗漏资料库刷新 |
| `src/main/library/libraryIndexService.ts` | 如沿用统一通知入口，只增加 projection change 转发或关系预检 |
| `src/main/preload.ts` | 共享 payload 类型透传，通常无需新增 IPC channel |
| `src/renderer/components/library/libraryTaskGrouping.ts` | 新增纯任务优先分组与比较逻辑 |
| `src/renderer/components/library/libraryDateGrouping.ts` | 保留日期格式函数；不再负责“文件先分日期” |
| `src/renderer/components/library/libraryLocalQueryState.ts` | 使用完整排序键完成定向 merge 和窗口判断 |
| `src/renderer/components/library/libraryRefreshCoordinator.ts` | projection change 标记权威刷新并合并 sessionIds |
| `src/renderer/components/library/LibraryView.tsx` | 接入新分组器、窗口重读、append generation 和锚点策略 |
| `src/renderer/components/library/LibraryVirtualizedGroups.tsx` | 仅在需要时把组字段从 `sortTime` 澄清为 `activityTime` |

不得顺带修改云端列表、分享设置、站点设置或 Artifact 预览器。

## 12. 实施步骤

### 阶段 1：冻结共享合同和纯比较器

1. 新增 `LibraryLocalSort` 和会话投影字段。
2. 定义五字段比较器及 v2 游标类型。
3. 新增纯 Renderer 任务分组器和单元测试。
4. 保持 `artifact.sortTime` 文件语义不变。

阶段门槛：使用内存对象证明任务组顺序、组内顺序、相同时间兜底和跨文件日期单组行为。

### 阶段 2：Main 权威查询和分页

1. 将 ownerSession 选择移动到 `LIMIT` 之前。
2. 实现任务优先 SQL 和五字段 keyset 谓词。
3. 在列表行中直接返回 owner 会话 `createdAt/updatedAt`。
4. 实现 v2 游标编码、严格解码和模式校验。
5. 保持计数、过滤和展示资格不变。

阶段门槛：SQLite 测试证明全量顺序前缀与逐页拼接完全一致。

### 阶段 3：Renderer 展示和增量合并

1. `LibraryView` 使用任务优先分组器。
2. 日期标题和任务组头改用任务活动时间。
3. 网格和预览继续使用文件时间。
4. 定向 merge 使用完整排序键。
5. 有后续页时，排序键、owner 或可见性变化升级为权威窗口刷新。
6. 任务跨页时合并唯一组头。

阶段门槛：现有虚拟化、滚动加载、搜索、分类、收藏和预览回归通过。

### 阶段 4：会话投影事件和窗口失效

1. 在 CoworkStore 写入边界集中检测真实投影变化。
2. 在 CoworkStore 删除边界统一收集受影响任务和产物，覆盖单删、批删及 Agent 级联删除。
3. Main 提交后分别转发 `session_projection_changed` 和唯一一次 `session_deleted`。
4. RefreshCoordinator 把投影变化合并为权威窗口刷新。
5. 使旧 append generation 和 `nextCursor` 失效。
6. 重读原已加载窗口并应用顶部/中部滚动策略。

阶段门槛：用户消息、状态切换、IM/定时任务、标题变化、无变化写入，以及普通/Agent 删除都具有准确事件次数。

### 阶段 5：性能、手工验证和发布

1. 在 100、1,000、10,000 条产物数据集执行查询基准和 `EXPLAIN QUERY PLAN`。
2. 验证单任务 100/1,000 个文件、多任务同毫秒时间和一个文件 100 个关系。
3. 完成 macOS/Windows 手工验证。
4. 审查是否需要额外只读索引；没有证据时不新增。
5. 检查 diff 不包含云端、分享、站点或无关大型文件格式化。

## 13. 测试计划

### 13.1 Main/SQLite 单元测试

至少覆盖：

1. 最近任务的旧文件排在旧任务的新文件之前；
2. 任务排序严格使用 `updatedAt → createdAt → sessionId`；
3. 任务内严格使用 `sortTime → itemId`；
4. session ID 位于 artifact 时间前，文件不会跨任务交错；
5. owner 仍按 `lastRelatedAt → session.updatedAt → sessionId` 选择；
6. 最近聊天但没有新关系的其他任务不会抢走 owner；
7. 删除 owner 后确定性回退并重新排序；
8. 分类、关键词和收藏在游标前生效；
9. missing 和无有效任务关系不产生短页；
10. 24、25、48、49 条边界逐页拼接无重复、无遗漏；
11. 单任务超过 24 条时连续跨页；
12. 多任务相同时间戳时顺序稳定；
13. v1、损坏、超长、错误 sort 的游标被拒绝；
14. v2 游标 encode/decode round trip；
15. `getLocalItems` 返回完整会话时间投影；
16. 已加载文件跨越旧游标边界时重读窗口并生成正确的新游标；
17. 未加载新项进入当前窗口时重读，不进入窗口时保留续页；
18. 计数仍为文件数。

### 13.2 CoworkStore 事件测试

至少覆盖：

- 用户消息推进 `updatedAt`，提交后发一次；
- assistant/tool 消息不推进、不发；
- 状态真实切换发一次，相同状态不发；
- 标题实际变化发一次但不推进时间；
- agentId 实际变化发一次；
- 历史同步只有更晚用户消息推进时发；
- 事务回滚不发；
- 监听器异常不影响持久化；
- 删除只走 `session_deleted`；
- 删除 Agent 时级联任务携带完整、去重的受影响资料 ID，并只发一次 `session_deleted`；
- 创建同 ID Agent 时若清理遗留任务，同样在最外层事务提交后通知；
- 多字段同事务合并为一次通知。

### 13.3 Renderer 单元测试

至少覆盖：

1. 一个任务的跨日期文件只生成一个任务组；
2. 日期标题来自 session 时间；
3. 任务组头时间来自 session 时间；
4. 网格文件时间仍来自 artifact 时间；
5. 任务组按 session tuple 排序；
6. 组内文件按 artifact tuple 排序；
7. 同一 session 的不一致投影不会拆组，并请求权威刷新；
8. 任务跨页追加只有一个组头；
9. 文件 `mtime` 变化只改变所属任务的组内位置，不改变任务组位置；
10. owner 改变后条目进入新任务组；
11. `hasMore=true` 时文件键/owner/可见性变化废弃旧 cursor 并重读窗口；
12. `hasMore=false` 时同类变化可以定向合并并正确重排；
13. projection change 废弃 append 和旧 cursor；
14. projection 事件风暴只产生一个刷新和一个尾随；
15. 刷新失败保留旧快照并禁止旧游标继续 append；
16. 顶部刷新保持顶部，中部刷新保持文件锚点；
17. 搜索、分类、收藏切换重置游标；
18. `favoritesOnly` 可见性变化使分页窗口失效，普通收藏更新保持乐观；
19. 迟到 v1/v2 请求不能覆盖新 generation；
20. 后台刷新不挂载整页骨架。

### 13.4 Electron 手工验证

1. 建立任务 A、B，让 A 最近活动但文件更旧，确认 A 在前。
2. 在同一任务关联跨多天 `mtime` 的文件，确认只有一个任务组。
3. 在系统编辑器修改旧任务文件，确认只改变组内顺序。
4. 继续一个已有产物任务但不生成新文件，确认任务组移动。
5. 任务运行期间观察 start/complete，确认不随流式 delta 频繁跳动。
6. 在 IM 或定时任务后台更新时停留资料库中部，确认静默重排和滚动稳定。
7. 删除 owner 任务，确认回退任务、顺序和可见性正确。
8. 删除包含多个任务的 Agent，确认相关文件立即回退或隐藏且只刷新一次。
9. 对单任务生成 120 个以上文件并跨五页，确认组头不重复、单次响应仍有界。
10. 组合搜索、类型、收藏并连续滚动，确认无短页、重复或遗漏。
11. 打开预览后触发任务重排，确认预览不关闭且目标不变。
12. macOS 与 Windows 各执行一次，Windows 同时覆盖 100%/125%/150% 缩放。

### 13.5 性能门槛

| 数据集/动作 | 目标 |
| --- | --- |
| 1,000 条产物、平均 2 个关系、首页 24 条 | SQLite 查询 P95 < 150ms |
| 10,000 条产物、平均 2 个关系、首页 24 条 | 不阻塞 Renderer；记录 P50/P95 和查询计划，P95 目标 < 300ms |
| 单任务 1,000 个产物 | 首页仍只返回 24 条，内存和 IPC 响应有界 |
| 一个产物 100 个任务关系 | owner 选择正确，查询不退化为 N+1 |
| 100 个 projection 事件/300ms | 1 个逻辑刷新，最多 1 个尾随 |
| 已加载 5 页后任务时间变化 | 静默重读原窗口，不清空列表、不跳回顶部 |

如果 10,000 条数据集不达标，必须先保存 `EXPLAIN QUERY PLAN` 和基准，再决定索引或查询改写；不能直接物化冗余 owner 字段。

## 14. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| session `updatedAt` 早于文件 `mtime` | 任务组仍按 session 时间；文件只在组内按 mtime |
| 文件 `mtime` 位于未来 | 不影响任务组位置；组内按现有时间值排序并保留诊断能力 |
| session 时间相同 | 用 `createdAt DESC, sessionId DESC` |
| 同组文件时间相同 | 用 `itemId DESC` |
| 同一任务文件跨多个自然日 | 全部归入 session `updatedAt` 所在日期 |
| 一个任务跨页 | 追加到同一个 `sessionId` 组，不重复组头 |
| 一个任务占满多页 | 继续按文件级分页；后续任务在该组耗尽后出现 |
| 筛选只命中任务部分文件 | 只显示命中文件，组时间不变 |
| session 标题变化但时间不变 | projection 事件触发静默刷新组头，不人为推进任务顺序 |
| session agent 变化 | 更新导航投影，任务时间不变 |
| assistant 流式输出 | 不推进 session 时间，不触发排序刷新 |
| 状态重复写 running | 不触发 projection 事件 |
| 后台 IM/定时任务推进时间 | 触发权威窗口刷新 |
| projection 事件涉及无产物任务 | Main 可通过关系预检跳过；漏做优化只影响性能，不影响正确性 |
| projection 事件到达时本地页隐藏 | 所有本地 query 快照标 dirty；返回时只刷新当前激活 query |
| projection 变化与 append 并发 | 新 generation 胜出，旧 append 丢弃 |
| projection 刷新失败 | 保留旧内容、标 dirty、停止旧 cursor 自动续页 |
| owner session 被删除 | 回退到下一有效关系并按新 session 时间排序 |
| Agent 删除并级联删除多个 session | 统一提交后删除通知触发定向读取或权威刷新，相关文件立即回退/隐藏 |
| 最后一个关系被删除 | 文件退出可见结果，真实文件和收藏保留 |
| 两个关系 `lastRelatedAt` 相同 | 只在 owner 选择中用 session 时间和 ID 兜底 |
| 旧 Main 缺少 session 时间字段 | 开发态临时按关系时间分组；正式包视为合同错误 |
| 旧 v1 游标 | 清游标并自动重取第一页一次 |
| 系统时区变化 | 下次分组计算使用新本地日期；任务相对顺序不变 |
| 文件权限异常 | 沿用现有 availability 行为，不修改任务时间 |
| 云端页 | 完全不应用本地任务排序和 projection 刷新 |

## 15. 验收标准

### 15.1 排序与分组

- [ ] 本地产物任务组严格按 `session.updatedAt DESC, session.createdAt DESC, sessionId DESC`。
- [ ] 同一任务文件严格按 `artifact.sortTime DESC, itemId DESC`。
- [ ] 同一任务文件在扁平结果中连续，不与其他任务交错。
- [ ] 日期标题使用任务时间，同一任务只出现一个组头。
- [ ] 任务组头显示任务活动时间，网格和预览继续显示文件修改时间。
- [ ] 任务置顶不影响资料库顺序。
- [ ] 云端资料排序和展示无变化。

### 15.2 归属与生命周期

- [ ] owner 选择仍按 `lastRelatedAt → session.updatedAt → sessionId`。
- [ ] 同一物理文件只显示一次。
- [ ] 纯文本继续任务不会改变文件 owner。
- [ ] 删除 owner 后正确回退并重新排序。
- [ ] 删除 Agent 后，所有级联任务影响只广播一次且相关文件即时回退或隐藏。
- [ ] 删除最后关系后隐藏文件但不删除真实文件、索引或收藏。
- [ ] 外部文件修改只改变任务组内顺序。

### 15.3 查询与分页

- [ ] ownerSession 在游标和 `LIMIT` 前解析。
- [ ] v2 游标包含完整五字段排序元组并严格校验。
- [ ] 任意页大小下逐页结果与全量权威顺序一致。
- [ ] 单任务跨页不重复组头、不重复文件、不漏文件。
- [ ] 有后续页时，文件键、owner、可见性或窗口前插变化都会重建窗口与 `nextCursor`。
- [ ] 过滤、收藏和展示资格在分页前生效。
- [ ] `counts` 继续按文件计数。
- [ ] 旧游标只自动清理和重试一次。

### 15.4 实时一致性和体验

- [ ] session 投影真实变化在提交后产生准确事件，流式 delta 和无变化写不产生事件。
- [ ] session projection change 使旧 cursor/append generation 失效并权威重读已加载窗口。
- [ ] projection change 使全部本地查询快照失效，但只立即刷新当前激活查询；云端缓存不受影响。
- [ ] 后台重排不显示整页骨架，不清空已有内容。
- [ ] 事件风暴满足 300ms/1,000ms、单执行中和单尾随约束。
- [ ] 顶部用户能看到新最近任务；列表中部保持文件视觉锚点。
- [ ] 排序变化不关闭有效预览、菜单或改变筛选条件。
- [ ] 刷新失败保留旧内容且不继续使用失效游标追加。

### 15.5 质量门槛

- [ ] 相关 Main/Renderer/共享 TypeScript 文件通过 changed-file ESLint。
- [ ] Main store、游标、分页、事件和 Renderer 分组测试通过。
- [ ] `npm run compile:electron` 通过。
- [ ] `npm run build` 通过。
- [ ] 目标 Vitest 通过。
- [ ] 1,000/10,000 条数据集保存查询计划和性能结果。
- [ ] macOS/Windows 手工验证通过。
- [ ] Diff 不包含云端、分享、网站、生成文件或无关格式化。

## 16. 最终设计结论

1. 本地产物改为任务优先：先按 Cowork session 最近活动时间排列任务组，再列出该任务当前唯一归属的文件。
2. 文件归属和任务排序是两个独立问题：owner 继续由最新实际产物关系决定，任务组位置由 owner session 的 `updatedAt` 决定。
3. 文件 `sortTime` 继续代表 `mtime`，只负责任务组内顺序及文件级展示，不能被任务时间覆盖。
4. 日期层级改为任务活动日期，同一任务不再因文件时间跨日期拆组。
5. Main 必须在分页前解析 owner session，并按五字段复合键执行 keyset pagination；只改 Renderer 是错误方案。
6. session 排序键可变，因此会话投影提交后必须发出精确事件，使当前窗口和游标静默失效、重读并收敛。
7. 首期保持文件级分页、一文件一条记录、最新任务唯一归属和现有虚拟化，不引入任务分页、重复文件或折叠交互。
8. 本次仅影响 Electron 本地产物页，不需要服务端或数据库数据迁移；性能是否需要新增索引，以 10,000 条基准和查询计划为准。
