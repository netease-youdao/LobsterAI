# 右边栏预览卡片自动打开设计文档

## 1. 概述

### 1.1 问题/背景

Cowork 会话已经能从模型回复、工具结果、本地文件链接和本地服务 URL 中解析 artifact，并在 assistant turn 底部展示 `ArtifactPreviewCard`。用户点击预览卡片时，现有行为为：

1. 本地服务卡片打开右边栏 Browser tab，并导航到本地服务 URL。
2. HTML 文件卡片打开右边栏 Browser tab，并通过 artifact preview session 预览本地 HTML 文件。
3. 视频、图片、文档等其他可预览卡片通过 `openArtifactPreviewTab` 打开右边栏预览 tab。

当前缺口是：如果右边栏关闭，模型回复中出现预览卡片时不会自动展开右边栏。用户需要手动点击卡片或右栏按钮，生成 HTML、图片、视频、本地服务等强预览内容时反馈不够直接。

### 1.2 目标

1. 当前会话右边栏关闭时，如果模型最新回复中出现可自动预览的预览卡片，自动打开右边栏并展示选中的预览内容。
2. 多个预览卡片同时出现时，按固定优先级自动选择：本地服务 > 文档 > HTML > 视频 > 图片。
3. 同类别多张卡片时，选择该 assistant turn 展示顺序中的第一个。
4. 自动打开行为复用现有手动点击链路，确保本地服务、HTML Browser tab、普通预览 tab 的表现一致。
5. 右边栏已经打开时不自动切换用户当前正在看的内容。
6. 不因历史会话已有预览卡片而自动打开右边栏。

### 1.3 非目标

1. 不改变 artifact 解析规则和去重规则。
2. 不改变用户手动点击预览卡片、打开方式菜单、外部应用打开等现有交互。
3. 不新增 artifact 可预览类型。
4. 不把代码、文本、Mermaid 等未列入优先级的卡片纳入本期自动打开范围。
5. 不实现用户级设置开关；本期按产品规则默认启用。

## 2. 用户场景

### 场景 1: 模型生成图片

**Given** 当前会话右边栏处于关闭状态。  
**When** 模型回复完成，并在回复中出现一个图片预览卡片。  
**Then** 右边栏自动打开，展示该图片预览。

### 场景 2: 模型同时生成文档、HTML 和图片

**Given** 当前会话右边栏处于关闭状态。  
**When** 同一个 assistant turn 中出现文档、HTML 卡片和图片卡片。  
**Then** 自动打开文档卡片对应的右边栏预览 tab，HTML 和图片不抢占。

### 场景 3: 模型启动本地服务并输出多个文件

**Given** 当前会话右边栏处于关闭状态。  
**When** 同一个 assistant turn 中出现本地服务 URL、HTML、视频、图片和文档卡片。  
**Then** 自动打开本地服务卡片，在右边栏 Browser tab 中导航到本地服务 URL。

### 场景 4: 同类卡片多张

**Given** 当前会话右边栏处于关闭状态。  
**When** 同一个 assistant turn 中出现两个视频卡片。  
**Then** 自动打开该 turn 展示顺序中的第一个视频。

### 场景 5: 用户正在查看右边栏

**Given** 当前会话右边栏已经打开，用户正在查看某个 artifact 或 Browser tab。  
**When** 模型回复中出现新的预览卡片。  
**Then** 不自动切换右边栏内容，不打断用户当前查看状态。

### 场景 6: 用户主动关闭右边栏

**Given** 模型回复过程中或刚完成后，用户主动关闭右边栏。  
**When** 同一轮回复后续异步加载出预览卡片。  
**Then** 不重新自动打开右边栏。

### 场景 7: 切换到历史会话

**Given** 历史会话中已经存在预览卡片。  
**When** 用户切换到该历史会话。  
**Then** 不因为历史卡片自动打开右边栏。

## 3. 功能需求

### FR-1: 自动预览候选类型

自动预览只处理当前已经会展示为预览卡片，并且属于以下类别的 artifact：

| 自动预览类别 | artifact type |
| --- | --- |
| 本地服务 | `ArtifactTypeValue.LocalService` |
| 文档 | `ArtifactTypeValue.Document`, `ArtifactTypeValue.Markdown` |
| HTML | `ArtifactTypeValue.Html` |
| 视频 | `ArtifactTypeValue.Video` |
| 图片 | `ArtifactTypeValue.Image`, `ArtifactTypeValue.Svg` |

补充规则：

1. `svg` 当前在卡片策略中按图片展示，因此归入图片。
2. `markdown` 当前在卡片策略中按文档展示，因此归入文档。
3. `text`, `code`, `mermaid` 暂不自动打开，即使它们可以被 ArtifactPanel 预览。
4. 候选选择必须使用 `ArtifactTypeValue` 常量，不新增裸字符串 discriminant。

### FR-2: 自动预览优先级

同一个 assistant turn 内存在多个候选卡片时，优先级固定为：

```text
本地服务 > 文档 > HTML > 视频 > 图片
```

同类别多个候选时，选择展示顺序中的第一个。展示顺序应和 `AssistantTurnBlock` 中 `ArtifactPreviewCard` 的卡片顺序一致，即先复用 `dedupeArtifactsForDisplay` 后再按列表顺序比较。

### FR-3: 触发条件

自动打开仅在以下条件同时满足时触发：

1. 当前会话存在新完成或新追加的 assistant turn。
2. 该 turn 中存在符合 FR-1 的自动预览候选。
3. 当前会话右边栏处于关闭状态。
4. 该 turn 尚未执行过自动打开，也未因用户关闭右边栏而被抑制。
5. 当前 session 是用户正在查看的 session。

### FR-4: 右边栏打开行为

自动打开必须复用预览卡片的主点击语义：

| 候选类型 | 自动打开动作 |
| --- | --- |
| 本地服务 | 调用 `handleOpenLocalServiceArtifact(artifact)`，打开 Browser tab 并导航到本地服务 URL |
| HTML 且有 `filePath` | 调用 `handleOpenHtmlFileInBrowser(artifact)`，打开 Browser tab 并创建本地 HTML preview session |
| HTML 但没有 `filePath` | `dispatch(openArtifactPreviewTab({ sessionId, artifactId }))` |
| 视频 / 图片 / 文档 | `dispatch(openArtifactPreviewTab({ sessionId, artifactId }))` |

自动打开不需要展开对话中的折叠卡片列表。即使目标卡片由于“最多展示 3 个”规则暂时折叠，右边栏仍可直接打开该 artifact。

### FR-5: 不覆盖用户当前上下文

1. 如果右边栏已经打开，不自动切换 active tab 或 selected artifact。
2. 如果用户在 pending 自动预览期间手动关闭右边栏，当前 turn 标记为 handled，后续同 turn artifact 到达也不再自动打开。
3. 如果 HTML preview session 创建失败，失败表现与手动点击 HTML 卡片一致，不降级打开其他低优先级卡片。

## 4. 实现方案

### 4.1 新增自动预览策略模块

建议新增：

```text
src/renderer/components/artifacts/autoPreviewPolicy.ts
```

职责：

1. 定义自动预览类别常量。
2. 提供 `getAutoPreviewCategory(artifact)`。
3. 提供 `selectAutoPreviewArtifact(artifacts, options)`。
4. 内部复用 `dedupeArtifactsForDisplay`，保证选择顺序与卡片展示一致。

建议类型：

```ts
export const ArtifactAutoPreviewCategory = {
  LocalService: 'local-service',
  Html: 'html',
  Video: 'video',
  Image: 'image',
  Document: 'document',
} as const;

export type ArtifactAutoPreviewCategory =
  typeof ArtifactAutoPreviewCategory[keyof typeof ArtifactAutoPreviewCategory];
```

核心选择逻辑：

```ts
const AUTO_PREVIEW_PRIORITY = [
  ArtifactAutoPreviewCategory.LocalService,
  ArtifactAutoPreviewCategory.Document,
  ArtifactAutoPreviewCategory.Html,
  ArtifactAutoPreviewCategory.Video,
  ArtifactAutoPreviewCategory.Image,
] as const;

export function selectAutoPreviewArtifact(
  artifacts: Artifact[],
  options?: { defaultProjectDirectory?: string },
): Artifact | null {
  return dedupeArtifactsForDisplay(artifacts, options)
    .map((artifact, displayIndex) => ({
      artifact,
      displayIndex,
      priority: getAutoPreviewPriority(artifact),
    }))
    .filter((item): item is AutoPreviewCandidate => item.priority !== null)
    .sort((a, b) => a.priority - b.priority || a.displayIndex - b.displayIndex)[0]
    ?.artifact ?? null;
}
```

### 4.2 抽取 turn artifact 关联 helper

`CoworkSessionDetail.tsx` 当前在 `renderConversationTurns()` 中局部计算 `turnMessageIds`，再过滤 `rawSessionArtifacts` 得到当前 turn 的卡片。自动预览也需要同样的关联关系，建议抽成局部 helper：

```ts
function getTurnMessageIds(turn: ConversationTurn): Set<string>
```

helper 覆盖：

1. `assistant` message id。
2. `system` message id。
3. `tool_result` message id。
4. `tool_group` 中的 tool use id 和 tool result id。

渲染卡片和自动预览都复用该 helper，避免两处规则漂移。

### 4.3 在 CoworkSessionDetail 中维护 pending / handled 状态

建议新增 refs：

```ts
const autoPreviewPendingTurnIdsRef = useRef<Record<string, string | null>>({});
const autoPreviewHandledTurnIdsRef = useRef<Record<string, Set<string>>>({});
const previousAutoPreviewStreamingRef = useRef(isStreaming);
const previousAutoPreviewMessagesLengthRef = useRef(messagesLength);
```

状态含义：

| 状态 | 含义 |
| --- | --- |
| pending turn | 最新完成或追加、等待 artifact 到达并尝试自动打开的 assistant turn |
| handled turn | 已经自动打开、因右边栏打开被跳过、或被用户手动关闭抑制的 turn |

### 4.4 设置 pending turn

在 `CoworkSessionDetail.tsx` 中新增 effect：

1. 监听 `isStreaming`、`messagesLength`、`turns`、`sessionId`。
2. 当 `isStreaming` 从 `true` 变为 `false` 时，找到最新 assistant turn，设置为当前 session 的 pending turn。
3. 当 `messagesLength` 增加且当前不在 streaming 时，也尝试设置最新 assistant turn，覆盖远程同步或恢复路径直接追加完整回复的情况。
4. session 切换时只初始化 refs，不扫描历史 artifacts 自动打开。

最新 assistant turn 的判断应以 `turn.assistantItems.length > 0` 或现有 `hasRenderableAssistantContent(turn)` 相关逻辑为基础，避免把空 turn 或纯用户 turn 设为 pending。

### 4.5 执行自动打开

新增 effect 监听：

```text
sessionId
isPanelOpen
rawSessionArtifacts
currentSession.cwd
pending turn id
handleOpenLocalServiceArtifact
handleOpenHtmlFileInBrowser
dispatch
```

执行流程：

1. 读取当前 session 的 pending turn。
2. 如果 pending turn 已 handled，退出。
3. 如果 `isPanelOpen` 为 `true`，把 pending turn 标记为 handled 并退出，不切换用户正在看的内容。
4. 使用 `getTurnMessageIds(pendingTurn)` 过滤出该 turn 的 `rawSessionArtifacts`。
5. 调用 `selectAutoPreviewArtifact(turnArtifacts, { defaultProjectDirectory: currentSession.cwd })`。
6. 如果没有候选，保持 pending，等待 HTML 文件读取、本地服务解析或媒体 artifact 异步入库后的下一次 effect。
7. 如果存在候选，启动一个短暂的 artifact settle timer；timer 期间 artifact 列表变化会取消并重新选择。
8. settle timer 到期后按 FR-4 执行打开，并将 pending turn 标记为 handled。

settle timer 用于覆盖 PPT / DOCX 等文档生成过程中伴随生成 HTML 辅助文件的场景：只要文档和 HTML 在稳定窗口内先后入库，最终选择仍按 `本地服务 > 文档 > HTML > 视频 > 图片` 执行。

### 4.6 用户手动关闭抑制

现有 `handleToggleArtifactPanel` 在用户关闭右边栏时会调用 `closePanel`。应在这个路径中增加：

1. 如果当前 session 有 pending turn，将它加入 handled。
2. 清空当前 session 的 pending turn。

这样可以覆盖用户明确关闭右边栏后，同一 turn 的后续异步 artifact 再次到达导致右栏重开的情况。

## 5. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| 右边栏已打开 | 标记当前 pending turn 为 handled，不自动切换 |
| 同一 turn 中高优先级卡片略晚于低优先级卡片入库 | 通过 artifact settle timer 等待列表短暂稳定，然后按最终 artifact 集合选择最高优先级 |
| 图片先入库并已自动打开，本地服务随后入库 | 不再二次切换；同一 turn 只自动打开一次 |
| HTML 文件 preview session 创建失败 | 沿用 `handleOpenHtmlFileInBrowser` 的失败 toast，不 fallback |
| 切换历史会话 | 不扫描历史 artifact 自动打开 |
| 用户关闭右边栏 | 当前 pending turn 标记 handled，后续不自动打开 |
| 目标卡片在对话中被折叠 | 仍允许右边栏自动打开该 artifact |
| artifact 被去重替换 ID | 选择和打开前复用 `dedupeArtifactsForDisplay` / `openArtifactPreviewTab` 的 display artifact 解析 |

## 6. 涉及文件

| 文件 | 变更 |
| --- | --- |
| `src/renderer/components/artifacts/autoPreviewPolicy.ts` | 新增自动预览类型映射和选择策略 |
| `src/renderer/components/artifacts/autoPreviewPolicy.test.ts` | 新增策略单测 |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | 增加 pending/handled 自动打开逻辑，复用现有打开 handlers |
| `src/renderer/services/artifactParser.ts` | 不计划修改；仅复用 `dedupeArtifactsForDisplay` |
| `src/renderer/store/slices/artifactSlice.ts` | 媒体 artifact 从远程占位替换为本地文件时，同步迁移已打开 preview tab 的 artifact id |

## 7. 验收标准

1. 右边栏关闭，模型回复只包含图片卡片时，回复完成后自动打开右边栏并展示图片。
2. 右边栏关闭，同一回复包含文档、HTML 和图片时，自动打开文档。
3. 右边栏关闭，生成 PPT 时伴随生成 HTML 辅助文件，自动打开 PPT 文档而不是 HTML。
4. 右边栏关闭，同一回复包含本地服务、HTML、视频、图片、文档时，自动打开本地服务。
5. 同一回复包含多个视频时，自动打开展示顺序第一个视频。
6. 右边栏已打开时，新回复出现预览卡片不会自动切换右边栏内容。
7. 用户手动关闭右边栏后，同一回复后续异步 artifact 到达不会重新打开右边栏。
8. 切换到已有历史会话时，不会因为历史预览卡片自动打开右边栏。
9. HTML 文件 preview session 创建失败时，失败行为与手动点击 HTML 卡片一致。
10. 选择策略单测覆盖优先级、同类取第一个、`svg` 归图片、`markdown` 归文档、非候选返回 `null`。

## 8. 验证计划

实现代码后建议运行：

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/renderer/components/artifacts/autoPreviewPolicy.ts src/renderer/components/artifacts/autoPreviewPolicy.test.ts src/renderer/components/cowork/CoworkSessionDetail.tsx
npm test -- autoPreviewPolicy
```

如果修改了右边栏交互，还需要用 `npm run electron:dev` 手动验证自动打开、手动关闭抑制、Browser tab HTML / 本地服务预览行为。
