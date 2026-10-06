# IM 会话列表渠道 Icon 展示设计文档

> 创建日期：2026-08-24  
> 状态：待评审  
> 涉及仓库：`LobsterAI`  
> 产品入口：LobsterAI 首页左侧「Agent 任务列表」与旧版 Cowork 会话列表  
> 参考：用户提供的会话列表示例截图、IM 机器人设置页截图、`2026-07-21-sites-management-analytics-design.md` 的文档结构

## 1. 概述

### 1.1 背景

当前 IM 渠道创建或同步到 LobsterAI 后，会话标题通常通过文字前缀表达来源，例如 `[微信] group:o9cq...`。这能帮助用户识别渠道，但在左侧会话列表中占用有限标题空间，也与 IM 机器人设置页已经使用渠道 logo 的视觉语言不一致。

本需求希望在 IM 来源会话前展示对应渠道 icon，并在列表展示层隐藏已有渠道文字前缀。数据库中的 `cowork_sessions.title` 不做迁移、不批量修改，避免影响用户历史数据、搜索、重命名和回滚。

### 1.2 代码现状核对

本设计基于 2026-08-24 对当前客户端代码的只读核对。

| 能力 | 当前状态 | 结论 |
| --- | --- | --- |
| IM 渠道与本地会话映射 | `im_session_mappings` 保存 `platform`、`cowork_session_id`、`agent_id`、`openclaw_session_key` | 可作为结构化渠道来源 |
| 会话列表数据 | `CoworkStore.listSessions()` / `searchSessions()` 返回 `CoworkSessionSummary` | 需要给 summary 补充 IM platform |
| 新 Agent 侧栏任务行 | `AgentTaskRow` 已支持任务前置 icon，例如定时任务 icon | 可在同一位置展示 IM icon |
| 旧 Cowork 会话项 | `CoworkSessionItem` 直接渲染标题 | 需要同步补 icon 与展示标题处理 |
| 渠道 icon 资源 | `PlatformRegistry.logo(platform)` 集中定义，设置页已复用 | 不需要新增图片资源 |
| 现有标题前缀 | `openclawChannelSessionSync.ts` 使用 `[渠道]` 前缀；直连 NIM 使用 `云信-P2P-` 等标题 | 需要展示层识别并隐藏已知前缀 |

### 1.3 目标

1. IM 来源会话在任务列表标题前展示对应渠道 icon。
2. 渠道 icon 复用 IM 机器人设置页的 `PlatformRegistry.logo(platform)` 资源。
3. 列表展示层隐藏已知渠道文字前缀，例如 `[微信] `、`[飞书] `、`[POPO] `。
4. 不修改用户数据库中的 `cowork_sessions.title`，不做历史数据迁移。
5. 非 IM 会话展示保持不变。
6. 搜索、排序、置顶、未读、运行中、定时任务、批量选择、重命名等现有行为保持不变。
7. 旧版 Cowork 会话列表和新版 Agent 任务树显示一致。

### 1.4 非目标

| 非目标 | 说明 |
| --- | --- |
| 批量清洗历史标题 | 不更新 SQLite 中已有 `title` |
| 改变 IM 会话创建标题规则 | `openclawChannelSessionSync` 和 `IMCoworkHandler` 可保持现状 |
| 新增渠道 logo 设计 | 首期只复用 `public/` 下已有资源 |
| 展示多实例账号 icon | 多实例先展示平台 icon，不展示具体 bot 头像或账号 |
| 改造 IM 会话映射模型 | 不新增 `im_account_id` 等结构字段 |
| 改变搜索匹配字段 | 搜索仍按数据库标题匹配，展示结果再隐藏前缀 |

## 2. 用户与产品场景

### 场景 1：微信会话列表展示

**Given** 用户存在一个数据库标题为 `[微信] group:o9cq...` 的 IM 会话。  
**When** 用户查看左侧会话列表。  
**Then** 列表行前展示微信 icon，标题展示为 `group:o9cq...`，不展示 `[微信]` 文字。

### 场景 2：飞书、钉钉、POPO 等其他 IM 渠道

**Given** 用户存在飞书、钉钉、企微、QQ、云信、小蜜蜂、POPO、Telegram、Discord、邮箱等 IM 会话。  
**When** 用户查看左侧会话列表。  
**Then** 每条 IM 会话展示对应渠道 icon，并隐藏对应的已知渠道文字前缀。

### 场景 3：普通 Cowork 会话

**Given** 用户存在普通本地任务 `帮我做一个烘焙工作...`。  
**When** 用户查看左侧会话列表。  
**Then** 不展示 IM icon，不改动标题文本。

### 场景 4：用户重命名 IM 会话

**Given** 用户在列表中重命名一个 IM 会话。  
**When** 进入重命名状态。  
**Then** 输入框默认展示当前列表显示标题，不强制带回 `[微信]` 等渠道前缀。

**When** 用户保存新标题。  
**Then** 按用户输入内容更新数据库标题，不自动补回渠道文字前缀；后续列表仍根据 `imPlatform` 展示 icon。

### 场景 5：搜索 IM 会话

**Given** 数据库标题仍包含 `[微信] group:o9cq...`。  
**When** 用户搜索 `微信` 或 `group:o9cq`。  
**Then** 搜索匹配仍按数据库标题执行；结果展示时仍隐藏 `[微信]` 并显示微信 icon。

### 场景 6：缺少映射或未知渠道

**Given** 某个历史会话标题看起来像 `[微信] xxx`，但没有 `im_session_mappings` 记录。  
**When** 用户查看列表。  
**Then** 首期不展示 IM icon，也不隐藏标题前缀，避免误判用户手写标题。

## 3. 概念与数据定义

### 3.1 IM 会话来源

IM 会话来源以 `im_session_mappings.cowork_session_id = cowork_sessions.id` 为准。不要仅凭标题文本判断一条会话是否来自 IM。

```text
结构化来源存在 → 展示渠道 icon，可隐藏对应渠道文字前缀
结构化来源不存在 → 普通会话处理，不做标题清洗
```

### 3.2 Summary 字段

在主进程和 renderer 的 `CoworkSessionSummary` 增加可选字段：

```typescript
imPlatform?: Platform | null;
```

字段语义：

| 值 | 含义 |
| --- | --- |
| `undefined` | 旧 IPC 数据或临时本地 summary，未提供 IM 来源信息 |
| `null` | 已确认不是 IM 来源会话 |
| `Platform` | IM 来源会话，对应 `PlatformRegistry` 的平台 id |

### 3.3 渠道 icon 资源

渠道 icon 通过 `PlatformRegistry.logo(platform)` 获取，沿用设置页和 Agent 绑定页的资源。

| platform | 当前 logo | 常见标题文字 |
| --- | --- | --- |
| `weixin` | `weixin.png` | `[微信]` |
| `dingtalk` | `dingding.png` | `[钉钉]` |
| `feishu` | `feishu.png` | `[飞书]` |
| `wecom` | `wecom.png` | `[企微]`、`[企业微信]` |
| `qq` | `qq_bot.jpeg` | `[QQ]` |
| `nim` | `nim.png` | `[云信]`、`云信-P2P-`、`云信-群聊-`、`云信-圈组-` |
| `netease-bee` | `netease-bee.png` | `[小蜜蜂]` |
| `popo` | `popo.png` | `[POPO]` |
| `telegram` | `telegram.svg` | `[TG]`、`[Telegram]` |
| `discord` | `discord.svg` | `[Discord]` |
| `email` | `email.svg` | 龙虾邮箱渠道；兼容隐藏当前代码可能生成的 `[邮件]`、`[Email]`，以及产品展示名 `[龙虾邮箱]` |

## 4. 功能需求

### FR-1：列表查询返回 IM platform

`CoworkStore.listSessions()` 和 `CoworkStore.searchSessions()` 返回的每个 `CoworkSessionSummary` 必须包含 `imPlatform`。

建议实现方式：

1. 对 `cowork_sessions` 查询增加一个稳定子查询或 `LEFT JOIN`，按 `cowork_session_id` 找最近映射：

```sql
SELECT
  s.id,
  s.title,
  ...,
  (
    SELECT m.platform
    FROM im_session_mappings m
    WHERE m.cowork_session_id = s.id
    ORDER BY m.last_active_at DESC
    LIMIT 1
  ) AS im_platform
FROM cowork_sessions s
...
```

2. 将 `im_platform` 映射到 summary 的 `imPlatform`。
3. 若 `im_platform` 不是 `PlatformRegistry.platforms` 中的已知平台，则返回 `null` 或不展示 icon。

### FR-2：补充查询索引

为避免列表分页时对 `im_session_mappings` 做全表扫描，增加索引：

```sql
CREATE INDEX IF NOT EXISTS idx_im_session_mappings_cowork_session_id
ON im_session_mappings(cowork_session_id);
```

该索引可在 `IMStore` 的映射表初始化逻辑中创建。无需新增迁移文件即可在启动时补齐。

### FR-3：展示标题派生

新增纯函数用于列表展示：

```typescript
interface IMDisplayTitleResult {
  title: string;
  strippedPrefix: boolean;
}

function getIMDisplayTitle(title: string, platform?: Platform | null): IMDisplayTitleResult;
```

规则：

1. `platform` 为空时返回原标题。
2. `platform` 存在时，只隐藏该平台已知前缀。
3. 只处理标题开头的前缀，不处理中间文本。
4. 隐藏前缀后需要 `trimStart()`。
5. 如果隐藏后为空，回退到原标题，避免列表出现空白。
6. 对 NIM 直连标题，可隐藏开头的 `云信-`，保留 `P2P-xxx`、`群聊-xxx`、`圈组-xxx`；如果产品希望更简洁，可在后续版本再隐藏聊天类型。

### FR-4：任务行 icon 展示

在 `AgentTaskRow` 中：

- 如果 `task.imPlatform` 存在，展示 14px 或 16px 平台 icon。
- icon 位于标题前，与定时任务 icon 使用同一视觉层级。
- 同一行如果同时是定时任务和 IM 会话，定时任务 icon 优先展示，IM icon 可不展示；当前 IM 会话不应被标记为定时任务，冲突只作为防御处理。
- icon 需要 `shrink-0`，标题继续 `truncate`。
- `<img>` 需要 `alt=""`，并在外层提供 `title` 或 `aria-label`，例如 `微信`。
- 深色模式下不做反色处理，使用原 logo。

### FR-5：旧 Cowork 会话项同步支持

在 `CoworkSessionItem` 中使用同一 display helper 和 icon 渲染逻辑，确保未切到新版 Agent 侧栏的入口也显示一致。

### FR-6：重命名行为

重命名输入框默认使用展示标题：

```text
数据库 title: [微信] group:o9cq...
展示标题: group:o9cq...
重命名输入框初始值: group:o9cq...
保存后数据库 title: 用户输入的内容
```

原因：

- 用户在列表中看到的是什么，编辑时就应编辑什么；
- 不把渠道标识写回 title，后续由 `imPlatform` 和 icon 表达渠道；
- 用户主动输入 `[微信]` 时按普通文本保存，展示层仍会按已知前缀隐藏。

### FR-7：搜索行为保持不变

搜索查询仍使用数据库中的 `cowork_sessions.title`。本次不新增展示标题索引或搜索字段。

影响：

- 用户搜索 `微信` 仍可能命中历史 `[微信] ...` 会话；
- 结果展示不显示 `[微信]`，但 icon 已表达来源；
- 用户重命名后如果标题不再包含 `微信`，后续搜索 `微信` 不保证命中，这是不迁移数据库 title 的预期结果。

## 5. 技术设计

### 5.1 类型变更

需要修改：

- `src/main/coworkStore.ts`
  - `CoworkSessionSummary`
  - `CoworkSessionSummaryRow`
  - `mapSessionSummaryRow`
- `src/renderer/types/cowork.ts`
  - `CoworkSessionSummary`
- `src/renderer/components/agentSidebar/types.ts`
  - `AgentSidebarTaskNode`
- `src/renderer/components/agentSidebar/useAgentSidebarState.ts`
  - `toAgentSidebarTaskNode`

### 5.2 查询变更

需要覆盖以下查询路径：

| 路径 | 文件 | 说明 |
| --- | --- | --- |
| 全局会话列表 | `CoworkStore.listSessions()` | 首页初始列表、加载更多 |
| Agent 任务预览 | `CoworkStore.listSessions(agentId)` | Agent 侧栏任务树 |
| 搜索会话 | `CoworkStore.searchSessions()` | 搜索弹窗与搜索结果 |

建议封装公共 SQL 片段，避免四处复制 `im_platform` 子查询。

### 5.3 Renderer helper

新增文件建议：

```text
src/renderer/components/agentSidebar/imSessionDisplay.ts
```

或更通用地放在：

```text
src/renderer/components/cowork/imSessionDisplay.ts
```

导出：

```typescript
export function getIMSessionDisplayTitle(title: string, platform?: Platform | null): string;
export function getIMSessionPlatformLogo(platform?: Platform | null): string | null;
export function getIMSessionPlatformLabel(platform?: Platform | null): string | null;
```

如果两个列表组件都要使用，优先放到 `src/renderer/components/cowork/` 或 `src/renderer/utils/`，避免 `agentSidebar` 反向被 `cowork` 依赖。

### 5.4 UI 结构建议

Agent 任务行非重命名状态：

```tsx
{imIcon && (
  <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" title={label}>
    <img src={imIcon} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" draggable={false} />
  </span>
)}
<span className="truncate">{displayTitle}</span>
```

旧 Cowork 会话项标题行可使用同样结构，保持时间、状态和操作按钮布局不变。

### 5.5 不修改标题创建逻辑

以下逻辑首期不改：

- `openclawChannelSessionSync.ts` 中的 `getChannelTitlePrefix()`；
- `buildChannelDisplayName()`；
- `IMCoworkHandler.buildSessionTitle()`。

原因：

1. 历史标题保持可读，便于排查和日志比对；
2. 新旧客户端混用时不会出现完全没有渠道提示的标题；
3. 本需求只要求列表展示优化，不要求改变数据生成规则。

## 6. 风险与兼容性

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 列表查询增加子查询 | 大量历史映射时分页变慢 | 增加 `cowork_session_id` 索引；只取 `LIMIT 1` |
| 历史会话缺少 mapping | 无法展示 icon 或隐藏前缀 | 保持原样展示，不做标题文本猜测 |
| 一个 session 多个 mapping | icon 选择不确定 | 按 `last_active_at DESC LIMIT 1` 选择最近来源 |
| 未知 platform 值 | icon 资源不存在 | 校验 `PlatformRegistry`，未知则不展示 icon |
| 标题被用户重命名为渠道前缀开头 | 展示层可能隐藏用户手写前缀 | 仅对结构化 IM 会话隐藏，且只隐藏已知平台前缀 |
| icon 压缩标题空间 | 窄侧栏标题更短 | icon 使用固定小尺寸、`shrink-0`，标题继续 `truncate` |
| 定时任务 icon 与 IM icon 冲突 | 行首 icon 过多 | 定时任务 icon 优先；IM 会话正常不应进入定时任务分支 |
| 搜索命中和显示文本不同 | 搜索 `微信` 命中但结果不显示文字 | icon 提供来源，属于展示层隐藏前缀的预期行为 |

## 7. 测试计划

### 7.1 单元测试

新增或更新测试：

1. `CoworkStore.listSessions()` 返回 `imPlatform`。
2. `CoworkStore.searchSessions()` 返回 `imPlatform`。
3. 多条 mapping 时选择 `last_active_at` 最新平台。
4. 无 mapping 时 `imPlatform` 为 `null` 或 `undefined`，UI 不隐藏标题。
5. `getIMSessionDisplayTitle()` 对每个渠道隐藏对应前缀。
6. `getIMSessionDisplayTitle()` 不隐藏非匹配平台前缀。
7. NIM 直连标题 `云信-P2P-张三` 展示为 `P2P-张三`。

### 7.2 组件测试

建议覆盖：

1. `AgentTaskRow` 渲染 IM icon 与隐藏后的标题。
2. `AgentTaskRow` 普通任务不渲染 IM icon。
3. `CoworkSessionItem` 渲染 IM icon 与隐藏后的标题。
4. 重命名输入框初始值使用展示标题。

### 7.3 手工验证

手工准备以下会话：

| 会话 | 期望 |
| --- | --- |
| `[微信] group:o9cq...` + `imPlatform=weixin` | 显示微信 icon，标题 `group:o9cq...` |
| `[飞书] group:oc_...` + `imPlatform=feishu` | 显示飞书 icon，标题 `group:oc_...` |
| `[POPO] bot1:direct:user...` + `imPlatform=popo` | 显示 POPO icon，标题 `bot1:direct:user...` |
| `云信-P2P-张三` + `imPlatform=nim` | 显示云信 icon，标题 `P2P-张三` |
| `[微信] 手写标题` 无 mapping | 不显示 icon，标题保持 `[微信] 手写标题` |
| 普通任务 `北京气温` | 不显示 icon，标题保持不变 |

验证范围：

- 新 Agent 侧栏；
- 旧 Cowork 会话列表；
- 搜索弹窗；
- 置顶、取消置顶；
- 重命名；
- 批量选择；
- 深色模式；
- 窄侧栏宽度。

### 7.4 质量门禁

修改 TypeScript/TSX 后按仓库要求运行：

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <touched-files>
```

建议运行相关 Vitest：

```bash
npm test -- coworkStore
npm test -- AgentTaskRow
npm test -- CoworkSessionItem
```

如测试名称不可直接过滤，则运行实际新增或修改的 `.test.ts(x)` 文件对应过滤项。

## 8. 实施步骤

1. 在 `IMStore` 初始化中增加 `idx_im_session_mappings_cowork_session_id` 索引。
2. 扩展主进程和 renderer 的 `CoworkSessionSummary` 类型。
3. 修改 `CoworkStore.listSessions()` / `searchSessions()` 查询并映射 `imPlatform`。
4. 扩展 `AgentSidebarTaskNode`，在 `toAgentSidebarTaskNode()` 中传递 `imPlatform`。
5. 新增展示 helper，封装标题前缀隐藏、平台 label 和 icon 获取。
6. 修改 `AgentTaskRow` 渲染 IM icon 和展示标题。
7. 修改 `CoworkSessionItem` 渲染 IM icon、展示标题和重命名初始值。
8. 增加单元测试和组件测试。
9. 手工验证列表、搜索、重命名、深色模式和窄侧栏。

## 9. 待确认问题

1. 定时任务与 IM 会话同时出现时，是否只显示定时任务 icon，还是允许两个 icon 并排？本设计默认定时任务 icon 优先。
2. NIM 标题隐藏到 `P2P-张三` 是否足够，还是希望进一步隐藏 `P2P-` 只显示 `张三`？
3. 搜索结果中是否需要额外展示渠道 tooltip 或二级文字？首期默认只用 icon 表达来源。
