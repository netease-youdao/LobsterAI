# Cowork 当前对话搜索设计文档

> 状态：Implemented（待 macOS / Windows UI 验收）
>
> 日期：2026-07-21
>
> 分类：功能
>
> 适用范围：LobsterAI 桌面端 Cowork 主会话详情页
>
> 视觉基准：用户提供的 Codex 桌面端当前任务搜索截图；搜索浮层内部布局与视觉层级以该截图为准

## 1. 概述

### 1.1 问题/背景

LobsterAI 当前把 `CommandOrControl+F` 配置为全局“搜索任务”快捷键。用户触发后，
`App.tsx` 派发 `CoworkUiEvent.ShortcutSearch`，`Sidebar.tsx` 响应该事件并打开
`CoworkSearchModal`，用于跨会话搜索历史任务。

这一能力适合在首页或任务列表中查找过去的会话，但当用户已经打开一个较长的 Cowork
会话，想在当前对话中定位某个词、代码片段或前文结论时，仍然只能手动滚动。浏览器原生
页面查找也不能直接解决该问题，因为 Cowork 会话详情存在以下机制：

1. 长会话只把一个消息窗口加载到 Redux，较早消息需要分页读取；
2. `LazyRenderTurn` 会把远离视口的 turn 替换成等高占位元素；
3. assistant 内容由 Markdown、计划块、代码块等多个组件共同渲染；
4. 超过阈值的 Markdown 默认只渲染头尾轻量预览；
5. 流式回复和自动滚动可能在用户定位历史内容后继续改变页面位置。

因此，本功能不能通过 `window.find()`、扫描当前 `innerText` 或只过滤已加载消息实现，
而需要建立基于完整会话消息数据的搜索结果，并与现有消息分页、turn 懒渲染和滚动策略协同。

### 1.2 产品定义

本功能定义为：

> 在已打开的 Cowork 主会话中，使用 `Cmd/Ctrl+F` 打开标题栏右上角的当前对话搜索控件，
> 按出现顺序浏览用户消息和正式 assistant 回复中的文本命中，并把当前命中滚动到可视区域、
> 以高亮方式显示。

快捷键保持同一个可配置的 `ShortcutAction.Search`，但根据当前页面上下文改变目标：

| 当前上下文 | `Cmd/Ctrl+F` 行为 |
| --- | --- |
| 已打开 Cowork 主会话 | 搜索当前对话 |
| Cowork 首页，没有当前会话 | 打开现有历史任务搜索 |
| Skills、Kits、MCP、定时任务等管理页 | 打开现有历史任务搜索 |

侧边栏“搜索”按钮始终保持“搜索历史任务”的现有语义，不改为当前对话搜索。

### 1.3 目标

1. 在 Cowork 主会话详情页支持 `Cmd/Ctrl+F` 当前对话搜索。
2. 搜索打开后，以用户提供的 Codex 截图为视觉基准，用同构的两行浮层替换标题栏右侧现有操作区：第一行输入与关闭，
   第二行上一处、下一处和结果计数。
3. 支持逐个命中导航、首尾循环和当前命中高亮。
4. 搜索结果覆盖完整会话，而不仅是当前加载的消息窗口或当前 DOM。
5. 命中未加载消息时，复用现有消息窗口加载能力定位到目标附近。
6. 命中未渲染 turn 时，强制 `LazyRenderTurn` 渲染目标后再滚动和高亮。
7. 适配 macOS 和 Windows 不同的标题栏、窗口控制区与侧栏折叠布局。
8. 搜索关闭后恢复产物面板标签和按钮，不永久改变原有标题栏功能。
9. 搜索过程不向日志或埋点记录查询正文。

### 1.4 工程目标

1. 目标定位继续复用 `loadMessageWindowAroundIndex`；完整历史读取使用搜索专用的轻量分页 IPC，
   不把 tool/system 大正文或消息 metadata 复制到 renderer。无需新增 SQLite 表或 OpenClaw patch。
2. 将搜索状态、匹配计算和 DOM 高亮从超大的 `CoworkSessionDetail.tsx` 中提取到独立模块。
3. 将匹配算法设计为纯函数，覆盖中文、英文、Markdown 和同消息多次命中的单元测试。
4. 不关闭 Cowork 现有分页和懒渲染来换取搜索能力。

### 1.5 非目标

- 不替换或删除现有跨任务 `CoworkSearchModal`。
- 不新增第二套可配置快捷键；仍使用现有 `ShortcutAction.Search`。
- 不支持正则表达式、大小写敏感、整词匹配或搜索选项面板。
- 不搜索 thinking 正文、工具调用参数、tool result、system 消息、附件 metadata 或隐藏技术上下文。
- 不搜索 ArtifactPanel、内置浏览器页面、文件预览、设置页或侧边栏文字。
- 第一版不支持 Subagent 只读会话详情中的对话内搜索。
- 不建立全局全文搜索索引，不新增 SQLite FTS 表。
- 不为搜索结果提供替换、复制全部或导出能力。
- 不对 `CoworkSessionDetail.tsx` 做与本功能无关的整体拆分或重构。

## 2. 现状与约束

### 2.1 现有快捷键链路

现有链路为：

```text
App.tsx
  -> 匹配 ShortcutAction.Search
  -> window.dispatchEvent(CoworkUiEvent.ShortcutSearch)
  -> Sidebar.tsx
  -> 打开 CoworkSearchModal
```

`App.tsx` 当前在任何输入框、文本域、选择器或 contenteditable 获得焦点时提前退出快捷键处理。
当前对话搜索需要允许用户在 Cowork prompt 聚焦时按 `Cmd/Ctrl+F`，同时不能抢占 CodeMirror
等已经消费并 `preventDefault()` 的组件内搜索。

### 2.2 会话标题栏

主会话标题栏位于 `CoworkSessionDetail.tsx`，高度为 48px：

- 左侧为侧栏折叠时的按钮和会话标题；
- 右侧为 ArtifactPanel 标签、添加标签、展开/恢复按钮和面板开关；
- 整个标题栏是 Electron 可拖拽区域，交互元素必须使用 `non-draggable`。

搜索状态不能与现有右侧操作同时展示，否则在窄窗口、产物面板打开或标签较多时会发生挤压。
本设计要求在搜索打开期间以条件渲染替换整个右侧操作槽位。

### 2.3 平台窗口结构

macOS 使用 `titleBarStyle: hiddenInset`，红黄绿窗口按钮位于左上。侧栏折叠时，会话标题栏
已有 `pl-[68px]` 避让逻辑。

Windows 使用 `frame: false`，由 `WindowsAppTitleBar` 在应用最上方单独渲染 36px 高的窗口标题栏
和最小化、最大化、关闭按钮。Cowork 会话标题栏位于该标题栏下方。

当前对话搜索属于会话上下文，必须放在 Cowork 会话标题栏中，不能放进 Windows 全局窗口标题栏。

macOS 和 Windows 必须复用同一个搜索浮层组件及同一套内部视觉样式。平台差异只用于决定浮层的
承载层级、顶部偏移和窗口按钮避让，不得分别设计两种搜索框外观：

- macOS：浮层锚定 Cowork 会话标题栏右上角，保留左侧红黄绿窗口按钮避让；
- Windows：浮层锚定 `WindowsAppTitleBar` 下方的 Cowork 会话标题栏右上角，不进入 36px
  Windows 全局窗口标题栏，也不覆盖最小化、最大化和关闭按钮。

### 2.4 消息分页与懒渲染

`CoworkSession` 使用以下字段描述当前消息窗口：

```ts
interface CoworkSession {
  messages: CoworkMessage[];
  messagesOffset: number;
  totalMessages: number;
}
```

现有 `coworkService.loadMessageWindowAroundIndex(sessionId, absoluteIndex)` 可以根据完整消息历史中的
绝对下标读取目标附近的消息窗口。搜索结果必须保存同一口径的 `absoluteMessageIndex`，不能只保存
当前 `messages` 数组下标。

`LazyRenderTurn` 只渲染视口附近和被标记为 `alwaysRender` 的 turn。搜索导航需要复用或扩展
`forcedRailTurnIndex`，保证目标 turn 在 DOM 定位前已经实际渲染。

### 2.5 大 Markdown 轻量预览

`MarkdownContent` 对超过 8 KiB 的内容默认只渲染头 4 KiB 和尾 8 KiB。搜索可以命中被省略的
中间内容，因此当前活动命中位于大 Markdown 中时，需要临时强制该条消息完整渲染；否则结果计数
正确但页面无法显示高亮。

## 3. 用户场景

### US-1：在当前对话中打开搜索

**Given** 用户正在查看一个 Cowork 主会话

**When** 用户按下 `Cmd/Ctrl+F`

**Then** 标题栏右侧的产物操作区切换为当前对话搜索控件，输入框自动聚焦并选中已有查询文本。

### US-2：在首页搜索历史任务

**Given** 用户处于 Cowork 首页，没有打开当前会话

**When** 用户按下 `Cmd/Ctrl+F`

**Then** 系统继续打开现有 `CoworkSearchModal`，行为与本功能上线前一致。

### US-3：输入查询并浏览多个结果

**Given** 当前对话搜索已经打开

**When** 用户输入一个在当前会话中出现多次的词语

**Then** 第二行展示当前序号和总结果数，例如 `2 / 7 个结果`，当前命中使用橙色高亮，
其他已渲染命中使用较弱的黄色高亮。

**When** 用户按 Enter 或点击下一处

**Then** 系统定位到下一个命中。

**When** 用户按 Shift+Enter 或点击上一处

**Then** 系统定位到上一个命中。

### US-4：搜索未加载的历史消息

**Given** 查询命中一条不在当前 Redux 消息窗口中的旧消息

**When** 用户导航到该命中

**Then** 系统读取目标附近的消息窗口，强制渲染目标 turn，并将命中滚动到消息区中部。

### US-5：首尾循环

**Given** 当前激活的是最后一个搜索结果

**When** 用户导航到下一处

**Then** 激活第一个结果；从第一个结果导航到上一处时激活最后一个结果。

### US-6：关闭搜索并恢复标题栏

**Given** 当前对话搜索已经打开

**When** 用户按 Esc 或点击关闭按钮

**Then** 搜索控件和高亮被清理，标题栏恢复原来的 ArtifactPanel 操作区，当前滚动位置保持不变。

### US-7：流式回复期间搜索

**Given** 当前会话正在 streaming

**When** 用户打开搜索并定位到历史结果

**Then** 搜索保持可用，自动滚到底部被暂停，不把用户从当前搜索结果拉回最新回复。

**And** 新增长的正式 assistant 文本以节流方式更新结果总数，不持续重置当前激活结果。

### US-8：产物面板处于打开状态

**Given** ArtifactPanel 以普通分栏方式打开

**When** 用户打开当前对话搜索

**Then** ArtifactPanel 内容保持打开，仅标题栏右侧操作区被搜索控件临时替换。

**Given** ArtifactPanel 处于全屏展开状态

**When** 用户打开当前对话搜索

**Then** ArtifactPanel 恢复为普通分栏，使对话搜索结果可见；关闭搜索后不自动重新全屏展开。

### US-9：切换会话

**Given** 当前对话搜索已经打开

**When** 用户切换到另一个会话或返回 Cowork 首页

**Then** 原会话的搜索控件、查询缓存和高亮被清理，新会话不会继承查询状态。

## 4. 交互设计

### 4.1 标题栏状态

#### 4.1.1 视觉还原原则

用户提供的 Codex 搜索效果是本功能的 UI source of truth。实现时不得改成普通标题栏输入框、
单行搜索条、居中弹窗或 LobsterAI 现有“搜索任务”胶囊样式。允许根据 LobsterAI 主题 token 做
明暗主题适配，但以下结构、相对位置和视觉层级必须保持：

1. 整体是贴近窗口右上角的独立两行浮层卡片，而不是撑高整条会话标题栏；
2. 第一行从左到右依次为搜索图标、无独立边框的输入区域、竖分隔线和关闭按钮；
3. 第一行与第二行之间有一条完整的横分隔线；
4. 第二行左侧依次放置上一处、下一处两个轻量图标按钮，右侧显示结果计数；
5. 上一处和下一处不得移动到计数右侧，计数不得放入输入行；
6. 浮层使用大圆角、细描边和轻阴影；控件内部不得再套一层明显胶囊边框；
7. 空查询或无结果时箭头以低对比度 disabled 状态展示，仍保留原位置，避免布局跳动；
8. 浮层覆盖标题栏右侧操作区域；关闭后原操作区域在同一位置恢复。

正常状态：

```text
┌────────────────────────────────────────────────────────────────────┐
│ 会话标题                         Artifact tabs    [展开] [面板]   │
└────────────────────────────────────────────────────────────────────┘
```

搜索状态：

```text
┌────────────────────────────────────────────────────────────────────┐
│ 会话标题                         ╭────────────────────────────────╮ │
│                                  │ ⌕  搜索当前对话…          │ × │ │
└──────────────────────────────────┼────────────────────────────────┤─┘
                                   │ ↑   ↓             2 / 7 个结果 │
                                   ╰────────────────────────────────╯
```

第二行通过绝对定位从标题栏向内容区悬浮，不参与消息区布局，不改变消息容器高度和 `scrollTop`。

#### 4.1.2 截图对应关系

| Codex 截图中的元素 | LobsterAI 实现要求 |
| --- | --- |
| 右上角两行浮层 | 锚定 Cowork 会话标题栏右侧，替换 ArtifactPanel 标题栏操作区 |
| 左侧放大镜 | 使用项目现有同风格线性搜索图标，尺寸约 14–16px |
| 无边框输入区域 | 不显示浏览器默认 input 边框、focus ring 胶囊或填充底色 |
| 关闭按钮前竖线 | 保留竖分隔线；关闭按钮使用约 32px 可点击区域 |
| 上下箭头位于第二行左侧 | 保持箭头顺序为上一处、下一处，disabled 时降低透明度 |
| 结果数位于第二行右侧 | 使用等价本地化文案，例如 `1 / 1 个结果` / `1 / 1 results` |
| 当前词橙色高亮 | 当前命中使用接近截图的高饱和橙色，其他命中使用更弱的同色系高亮 |

### 4.2 尺寸与响应式规则

- 搜索浮层基准宽度为 340px，与参考截图比例一致；常规窗口下不因内容长度改变宽度。
- 窄窗口下允许在 240px 至 340px 之间收缩，不扩大为占满整行的搜索条。
- 会话标题保留 `min-w-0` 和单行截断；搜索控件不允许被标题挤出窗口。
- 第一行高度与 48px 会话标题栏对齐；第二行高度约 32px，整体视觉高度约 80px。
- 外层圆角建议约 18–20px；上、下两行共享同一个外轮廓，不能渲染成两个分离胶囊。
- 外层使用 1px 低对比度描边和轻阴影；浅色主题背景接近不透明的暖白/浅灰，深色主题使用
  对应表面色，但仍需保留边界和层级。
- 第一行左右内边距约 14–16px；图标、输入文字、分隔线和关闭按钮垂直居中。
- 第一行横分隔线贯穿卡片宽度；关闭按钮前的竖分隔线高度应短于第一行，视觉居中。
- 第二行左右内边距约 16px；箭头组靠左、结果计数靠右，使用低强调度次级文字颜色。
- 窄窗口下优先压缩标题宽度，再压缩搜索控件；关闭按钮和导航按钮不得被隐藏。
- 搜索容器、输入框和按钮全部使用 `non-draggable`。
- 浮层的 `z-index` 必须高于消息内容和标题栏普通操作，但不得覆盖 Windows 系统窗口控制层。

### 4.3 控件与键盘行为

| 操作 | 行为 |
| --- | --- |
| `Cmd/Ctrl+F` | 打开搜索；已打开时聚焦并选中查询文本 |
| 输入查询 | 更新结果；空查询不显示命中高亮 |
| `Enter` | 下一处 |
| `Shift+Enter` | 上一处 |
| 点击向下箭头 | 下一处 |
| 点击向上箭头 | 上一处 |
| `Esc` | 关闭当前对话搜索 |
| 点击 `×` | 关闭当前对话搜索 |

IME 组合输入期间，Enter、Shift+Enter 和 Esc 必须交给输入法处理。判断至少覆盖
`event.isComposing`，并与项目现有输入法兼容逻辑保持一致。

### 4.4 结果状态

| 状态 | 展示 |
| --- | --- |
| 查询为空 | 结果区域留空，上一处/下一处 disabled |
| 正在读取完整历史 | 显示轻量 loading 状态，保留输入能力 |
| 无结果 | `0 / 0 个结果`，上一处/下一处 disabled |
| 有结果 | `当前序号 / 总数 个结果` |
| 读取失败 | 展示 `无法搜索当前对话`，允许修改查询或重新打开 |

### 4.5 高亮

- 当前激活命中使用接近参考截图的高饱和橙色背景，不使用浏览器默认蓝色选区。
- 当前命中文字使用深色前景，保持类似截图中橙底黑字的视觉效果。
- 其他已经渲染到 DOM 的命中使用同一橙色系的低透明度背景，不能与当前命中等强。
- 高亮只包裹实际命中文字，不扩展到整条消息或整段文本；圆角应轻微，不渲染成消息胶囊。
- 深色主题下必须保证文字与背景对比度。
- 高亮不能修改消息字符串、复制结果或 Markdown DOM 结构。
- 搜索关闭、切换会话或组件卸载时必须删除全部注册的高亮 Range。

## 5. 功能需求

### FR-1：上下文快捷键路由

保留 `ShortcutAction.Search` 和用户现有快捷键配置。在 `App.tsx` 中按当前页面路由：

1. `mainView === 'cowork'` 且存在 `currentSessionId` 时，派发新增的当前对话搜索事件；
2. 其他情况下派发现有 `CoworkUiEvent.ShortcutSearch`；
3. 侧边栏搜索按钮继续直接打开 `CoworkSearchModal`；
4. 已被内部编辑器 `preventDefault()` 的搜索快捷键不得被全局路由再次处理；
5. Cowork prompt 聚焦时允许当前对话搜索，不因 `isTextEditingActive()` 提前退出；
6. 快捷键设置录制控件仍优先，不触发任何搜索。

新增事件名必须加入 `CoworkUiEvent` 常量对象，例如：

```ts
ShortcutConversationSearch: 'cowork:shortcut:conversation-search'
```

消费代码不得散落同值裸字符串。

### FR-2：搜索打开与关闭状态

搜索状态按当前 `sessionId` 隔离，但第一版不跨会话保存：

```ts
interface CoworkConversationSearchState {
  isOpen: boolean;
  query: string;
  status: CoworkConversationSearchStatus;
  matches: CoworkConversationSearchMatch[];
  activeMatchKey: string | null;
}
```

打开时：

1. 如果 ArtifactPanel 全屏展开，恢复普通分栏；
2. 读取或复用当前搜索会话的完整消息缓存；
3. 聚焦输入框；已有查询时全选文本；
4. 有查询和结果时保持当前 `activeMatchKey`，不无条件跳回第一个结果。

关闭时：

1. 清空查询、结果、完整消息缓存和 DOM 高亮；
2. 取消尚未完成的定位任务和定时器；
3. 恢复标题栏右侧 ArtifactPanel 操作区；
4. 保持当前消息滚动位置；
5. 不恢复搜索打开前的 ArtifactPanel 全屏状态。

### FR-3：搜索范围

第一版只搜索以下消息：

- `message.type === 'user'`；
- `message.type === 'assistant'` 且 `metadata.isThinking !== true`。

不搜索：

- thinking；
- `tool_use`；
- `tool_result`；
- `system`；
- 附件文件名、图片 alt、Skill / Kit badge、消息时间、模型名等辅助 UI；
- ArtifactPanel 和 SubagentPanel 内容。

用户消息先复用 `parseUserMessageForDisplay()`，移除 IM 媒体包装、系统时间行和 `/goal` 控制前缀。
assistant 消息应包含普通可见回复和 proposed plan 正文，并移除 `MEDIA:` 等纯传输标记。

### FR-4：匹配语义

匹配规则为：

1. 查询去除首尾空白；中间空白保持原义；
2. 使用不区分大小写的字面子串匹配；
3. 不把查询拆成多个 token，不做模糊匹配；
4. 对换行符做 `CRLF/CR -> LF` 归一化；
5. 同一消息中的每次非重叠出现都计为一个独立结果；
6. 结果按完整消息顺序、消息内出现顺序排列；
7. Markdown 标题、列表、强调、链接等语法标记不应成为用户必须输入的字符；
8. 链接按可见 label 搜索，不因隐藏 URL 产生结果；自动链接 URL 因其本身可见，可以搜索；
9. fenced code 和 inline code 的正文纳入搜索；图片地址和不可见 Markdown 目标地址不纳入搜索；
10. 单次搜索最多保留 10,000 个结果，达到上限时计数显示为 `10000+`，防止极端高频词在超长
    会话中产生无界对象和 DOM Range 分配。

建议结果类型：

```ts
export interface CoworkConversationSearchMatch {
  key: string;
  messageId: string;
  messageType: 'user' | 'assistant';
  absoluteMessageIndex: number;
  occurrenceIndex: number;
}
```

`key` 由 `messageId + occurrenceIndex` 生成。查询变化会先清空旧选择，因此无需把查询正文复制到每个
结果 key 中；这样也能避免长查询在大量结果时造成额外内存占用。

### FR-5：轻量完整历史缓存

搜索打开时按以下顺序构建完整消息缓存：

1. 调用搜索专用 `getSessionSearchMessages`，每页检查固定数量的完整 mixed-message 顺序行；
2. 主进程只投影非 thinking 的 user/assistant 文本、时间戳、id 和数据库完整顺序中的
   `absoluteMessageIndex`，不跨 IPC 返回 tool/system 正文或 metadata；
3. 分页使用 `(COALESCE(sequence, created_at), created_at, ROWID)` keyset cursor，并由复合索引支持；
   总数只在首屏计算一次，后续页携带已知总数，避免长会话重复排序、OFFSET 扫描和 COUNT；
4. 每页校验 offset、cursor、total 单调性和消息 id；零进度、时间线收缩/漂移或页数越界时安全失败；
5. Redux 当前窗口及 detached tail 只按 message id 更新已缓存文本；新增尾部从最后 cursor 增量读取，
   继续使用主进程提供的绝对下标，不按筛选后的数组重排；
6. 缓存只存在于搜索 hook 生命周期中，不写入 Redux、不改变当前消息窗口；关闭、卸载或切换 session
   会使 request token 失效，停止后续页并丢弃部分结果；
7. 文本导出仍使用完整 `getSessionMessages` 数据和原有合并规则，不受轻量搜索投影影响。

### FR-6：查询更新与异步竞态

- 查询变化后可以使用约 80–150ms 防抖，避免长会话每次键入都立即扫描全部文本。
- 每次匹配计算使用递增 request id 或等价的版本 token；旧查询完成后不得覆盖新查询结果。
- 查询变化后清理旧结果和选择；新一轮匹配完成后激活第一个结果，避免把旧查询的 occurrence
  身份错误映射到新查询。
- 查询为空时立即清理结果和高亮，不等待防抖。
- 匹配计算不得阻塞输入超过一个可感知帧；如完整搜索文本很大，应分批计算或让出主线程。
- 实现按固定消息批次扫描，并在批次间让出主线程；旧批次通过 request id 及时停止。

### FR-7：未加载消息定位

导航到结果时：

1. 根据 `absoluteMessageIndex` 判断目标是否位于当前
   `[messagesOffset, messagesOffset + messages.length)` 窗口；
2. 不在窗口内时调用
   `coworkService.loadMessageWindowAroundIndex(sessionId, absoluteMessageIndex)`；
3. 等待 Redux 当前会话仍为原 session，忽略已切换会话的异步结果；
4. 在新窗口中重新构建 turn，并通过 message id 找到目标 turn index；
5. 如果加载失败，保持搜索控件打开并显示非阻塞错误，不删除其他结果。

### FR-8：懒渲染、滚动和自动滚底

- 目标 turn 必须通过 `forcedRailTurnIndex` 或等价机制强制渲染。
- DOM 查询必须有有限次数或有限时长的等待，不能使用无界轮询。
- 目标元素出现后，将当前命中滚动到消息容器视觉中部，避免被标题栏搜索第二行或底部输入框遮挡。
- 远距离跳转、近距离跳转和 `prefers-reduced-motion` 应复用消息 rail 当前的滚动决策，
  不为搜索建立相反的动画策略。
- 用户开始搜索或导航结果后，应将自动滚底视为用户主动脱离底部；streaming 不得抢回滚动位置。
- 搜索关闭后不自动滚到底部。用户可使用现有“滚动到底部”按钮恢复。

### FR-9：大内容与折叠内容

- 当前命中位于 `MarkdownContent` 被省略的中间内容时，临时强制该条消息完整渲染。
- `MarkdownContent` 如新增控制 prop，应是明确的可选 prop，例如 `forceExpanded`，默认行为保持不变；
  只有 Cowork 当前搜索目标传入该 prop。
- ProposedPlanBlock 当前默认展开；如果用户手动折叠，而当前命中位于计划正文，应临时展开或提供
  受控的搜索展开状态。
- thinking 和工具组不在搜索范围，因此搜索不得自动展开这些块。
- 当前匹配切换到其他消息或搜索关闭后，可恢复大内容原本的轻量预览状态；不得修改用户持久设置。

### FR-10：DOM 标记与高亮

用户消息和正式 assistant 消息根节点增加统一标记：

```html
data-cowork-search-message-id="<message-id>"
```

搜索高亮建议使用 Chromium CSS Custom Highlight API：

1. 在当前消息滚动容器内通过 TreeWalker 收集目标消息的可见文本节点；
2. 把消息内匹配映射为 DOM `Range`；
3. 使用两个命名 Highlight 分别注册普通匹配和当前匹配；
4. 当前匹配 Highlight 后注册，保证视觉优先级；
5. 组件更新后重新建立受影响的 Range，不能保留指向已卸载节点的 Range；
6. 清理时调用 `CSS.highlights.delete()` 删除本功能命名高亮。
7. DOM 消息节点只建立一次 id 映射，避免按完整历史中的每个命中重复扫描当前容器。

不得通过字符串替换向 Markdown 输出插入 `<mark>`，避免破坏链接、代码块、KaTeX、文本选择和复制。

### FR-11：ArtifactPanel 状态

标题栏右侧采用互斥渲染：

```text
isConversationSearchOpen
  ? CoworkConversationSearch
  : ExistingArtifactHeaderActions
```

- 普通分栏打开时，不关闭 ArtifactPanel，不改变 active tab。
- 全屏展开时，打开搜索应调用现有恢复分栏路径。
- 搜索关闭时恢复标签和按钮，标签滚动位置尽量保持。
- 搜索期间 ArtifactPanel 内容区仍可操作，但其标题栏操作暂时不可见。
- 如果产品后续要求搜索 Artifact 内容，应作为独立范围另写 spec，不扩展本搜索状态。

### FR-12：流式更新

- 搜索打开且当前 session streaming 时，监听当前正式 assistant 内容变化。
- 对完整消息缓存中的同 message id 使用最新内存消息覆盖旧版本。
- 重新计算结果应节流；完整历史扫描最多每秒一次，避免流式 delta 高频触发 CPU 和临时对象分配。
- 如果当前 `activeMatchKey` 仍存在，保持当前结果和滚动位置。
- 新结果出现在当前结果之前时，只更新显示序号，不强制跳转。
- 当前激活结果因流式文本重写而消失时，选择原位置之后最近的结果；没有结果时进入空结果状态。

### FR-13：i18n、可访问性与隐私

所有用户可见文案必须添加中英文。预计 key：

| key | zh | en |
| --- | --- | --- |
| `coworkConversationSearchPlaceholder` | 搜索当前对话… | Search this conversation… |
| `coworkConversationSearchPrevious` | 上一处 | Previous result |
| `coworkConversationSearchNext` | 下一处 | Next result |
| `coworkConversationSearchClose` | 关闭搜索 | Close search |
| `coworkConversationSearchResults` | `{current} / {total} 个结果` | `{current} / {total} results` |
| `coworkConversationSearchNoResults` | `0 / 0 个结果` | `0 / 0 results` |
| `coworkConversationSearchFailed` | 无法搜索当前对话 | Couldn't search this conversation |

可访问性要求：

- 容器使用 `role="search"`；
- 输入框有明确 `aria-label`；
- 上一处、下一处和关闭按钮有 i18n `aria-label`；
- 结果计数使用礼貌的 `aria-live="polite"`，防抖后播报；
- disabled 导航按钮必须使用原生 `disabled`；
- 焦点环在明暗主题下可见。

日志和埋点只允许记录：打开/关闭、查询长度、结果数量 bucket、导航方向、是否跨分页定位、成功/失败。
不得记录查询正文、命中文本、消息正文或前后文片段。

## 6. 实现方案

### 6.1 模块边界

为避免继续扩大 `CoworkSessionDetail.tsx`，建议新增：

| 模块 | 职责 |
| --- | --- |
| `CoworkConversationSearch.tsx` | 两行搜索控件、输入、按钮、计数与可访问性 |
| `useCoworkConversationSearch.ts` | 打开/关闭、完整消息缓存、查询状态、结果身份和前后导航 |
| `conversationSearch.ts` | 可搜索文本规范化、字面匹配、结果排序等纯函数 |
| `conversationSearchHighlight.ts` | TreeWalker、Range、CSS Highlight 注册与清理 |
| `conversationSearchLogger.ts` | 不含查询正文的 renderer 关键诊断日志 |

`CoworkSessionDetail.tsx` 只保留：

- 搜索事件接入；
- 标题栏右侧插槽切换；
- `scrollContainerRef` 和当前 session 数据传递；
- ArtifactPanel 全屏恢复；
- turn 强制渲染和目标滚动协调。

不抽取与搜索无关的 ArtifactPanel、导出、权限、消息 rail 或输入区逻辑。

### 6.2 搜索状态常量

跨组件比较的状态必须集中定义：

```ts
export const CoworkConversationSearchStatus = {
  Idle: 'idle',
  Loading: 'loading',
  Ready: 'ready',
  Error: 'error',
} as const;

export type CoworkConversationSearchStatus =
  typeof CoworkConversationSearchStatus[keyof typeof CoworkConversationSearchStatus];
```

不得在 hook、UI 和测试中分别使用裸字符串状态。

### 6.3 搜索文本规范化

`conversationSearch.ts` 提供纯函数：

```ts
getCoworkConversationSearchText(message: CoworkMessage): string | null
findCoworkConversationMatches(messages: CoworkMessage[], query: string): CoworkConversationSearchMatch[]
```

规范化职责：

1. 过滤不在搜索范围内的消息；
2. user message 复用 `parseUserMessageForDisplay()`；
3. assistant message 复用 proposed plan 和媒体 token 的现有解析规则；
4. 保留 fenced code 内容，只移除 fence 标记；
5. Markdown 链接替换为 label，图片语法移除地址；
6. 去除标题、列表、引用、强调等不显示为正文字符的语法标记；
7. 归一化换行，但不合并普通正文空格；
8. 返回用于计数和结果身份的稳定文本。

搜索规范化不是 Markdown renderer 的替代品。DOM 高亮仍以实际渲染文本为准；当规范化结果与 DOM
存在无法避免的差异时，导航必须至少定位到正确消息，不能因单个 Range 映射失败让整个搜索失效。

### 6.4 数据流

```text
Cmd/Ctrl+F
  -> App 按上下文派发 ShortcutConversationSearch
  -> CoworkSessionDetail 打开搜索并恢复 ArtifactPanel 分栏
  -> hook 读取完整消息缓存
  -> query 防抖后执行纯函数匹配
  -> 选择 activeMatchKey
  -> 确保 absoluteMessageIndex 对应窗口已加载
  -> 强制目标 turn 渲染
  -> 等待 data-cowork-search-message-id 出现
  -> 滚动到目标并注册普通/当前 Highlight
```

### 6.5 与消息 rail 导航复用

搜索和现有消息 rail 都要处理远距离滚动、分页窗口和懒渲染。实现时优先抽取或复用以下通用能力：

- 判断目标 absolute message index 是否已加载；
- 根据目标 message id 查找 turn index；
- `getRailNavigationDecision()` 的远近跳转和 reduced-motion 策略；
- 强制 turn 渲染后的有限等待；
- 用户主动导航后脱离自动滚底。

不得复制一套与 rail 行为不同的 `setTimeout + scrollIntoView` 链路。

### 6.6 高亮生命周期

高亮控制器输入：

```ts
interface ConversationSearchHighlightOptions {
  root: HTMLElement;
  query: string;
  matches: CoworkConversationSearchMatch[];
  activeMatchKey: string | null;
}
```

控制器只处理当前实际渲染的消息元素。完整结果计数来自消息数据，未渲染结果不需要提前创建 DOM Range。
用户导航到未渲染结果后，完成分页和强制渲染，再将其加入高亮集合。

当前命中 Range 创建失败时：

1. 仍滚动到对应消息容器；
2. 给消息容器增加短暂、弱化的 fallback ring；
3. 记录不含文本的 debug 诊断；
4. 不删除该搜索结果，也不阻止继续导航。

### 6.7 组件透传

为支持目标消息强制展开和统一 DOM 标记，建议使用明确 prop：

```text
CoworkSessionDetail
  -> UserMessageItem
  -> AssistantTurnBlock
     -> AssistantMessageItem
        -> MarkdownContent
        -> ProposedPlanBlock
```

可选 prop 示例：

```ts
searchTargetMessageId?: string | null;
forceSearchContentExpanded?: boolean;
```

不把整个搜索 hook 或匹配数组传入通用 Markdown 组件。通用组件只接收是否强制完整展示的最小信息。

## 7. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| 当前没有会话 | 打开现有历史任务搜索，不显示当前对话搜索 |
| 当前会话没有消息 | 搜索可打开，输入后显示 `0 / 0 个结果` |
| 查询只有空白 | 视为空查询，清理结果和高亮 |
| 同一消息多次出现 | 每个非重叠出现分别计数和导航 |
| 大小写不同 | 英文按不区分大小写匹配；中文不受影响 |
| 查询含正则特殊字符 | 按普通字面字符搜索，不作为正则 |
| 高频词命中超过 10,000 次 | 保留前 10,000 个结果，计数显示 `10000+`，并记录一次不含查询正文的 warning |
| 结果位于未加载历史 | 加载目标附近消息窗口后定位 |
| 结果位于 LazyRenderTurn 占位 | 强制目标 turn 渲染后定位 |
| 结果位于大 Markdown 中段 | 临时完整渲染当前目标消息 |
| Markdown 高亮 Range 无法映射 | 定位消息并显示 fallback ring，继续允许导航 |
| 查询变化时旧请求较晚完成 | 通过 request id 丢弃旧结果 |
| 查询变化 | 清理旧结果和选择；新结果完成后从第一项开始 |
| 流式文本新增结果 | 节流更新计数，保持当前结果身份和滚动位置 |
| 流式文本删除当前结果 | 选择原位置之后最近结果，无结果则显示空状态 |
| 搜索时用户手动滚动 | 保持搜索打开，不自动重新定位当前结果 |
| 搜索时切换会话 | 清理旧 session 的状态、高亮、timer 和异步定位 |
| 搜索时删除当前会话 | 关闭搜索并回到正常导航流程 |
| 完整消息读取失败 | 显示非阻塞失败状态，不影响会话阅读和输入 |
| ArtifactPanel 普通分栏 | 面板保持打开，只替换标题栏操作区 |
| ArtifactPanel 全屏 | 搜索打开时恢复分栏，关闭搜索不重新全屏 |
| macOS 侧栏折叠 | 保留左侧 68px 窗口按钮避让，搜索只占右侧 |
| Windows | 搜索位于独立窗口标题栏下方，不覆盖窗口控制按钮 |
| CodeMirror 已处理 Cmd/Ctrl+F | 尊重 `defaultPrevented`，不打开会话搜索 |
| 中文输入法组合态 | Enter、Shift+Enter、Esc 不触发搜索导航或关闭 |
| reduced motion | 远近跳转均使用无动画或现有 reduced-motion 策略 |

## 8. 涉及文件

预计涉及：

| 文件 | 修改 |
| --- | --- |
| `src/renderer/App.tsx` | 按当前视图和 session 路由搜索快捷键，调整输入焦点和 `defaultPrevented` 规则 |
| `src/renderer/components/cowork/constants.ts` | 新增当前对话搜索 UI 事件常量 |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | 标题栏槽位、搜索事件、目标 turn 渲染、滚动与 ArtifactPanel 状态协调 |
| `src/renderer/components/cowork/CoworkConversationSearch.tsx` | 新增两行搜索控件 |
| `src/renderer/components/cowork/useCoworkConversationSearch.ts` | 新增搜索状态、完整历史缓存和导航 hook |
| `src/renderer/components/cowork/conversationSearchHistoryLoader.ts` | 有界 keyset 分页、取消和时间线一致性保护 |
| `src/renderer/components/cowork/conversationSearch.ts` | 新增纯搜索与文本规范化函数 |
| `src/renderer/components/cowork/conversationSearchHighlight.ts` | 新增 CSS Highlight / Range 控制器 |
| `src/renderer/components/cowork/UserMessageItem.tsx` | 增加统一搜索消息 DOM 标记 |
| `src/renderer/components/cowork/AssistantTurnBlock.tsx` | 透传当前搜索目标消息 |
| `src/renderer/components/cowork/AssistantMessageItem.tsx` | 增加统一搜索消息 DOM 标记和强制完整展示参数 |
| `src/renderer/components/cowork/ProposedPlanBlock.tsx` | 当前搜索目标需要时临时展开计划正文 |
| `src/renderer/components/MarkdownContent.tsx` | 增加默认关闭的受控强制完整展示能力 |
| `src/renderer/services/i18n.ts` | 增加中英文搜索文案 |
| `src/renderer/index.css` | 增加普通命中和当前命中的 Highlight 样式 |
| `src/main/coworkStore.ts`、`src/main/main.ts`、`src/main/preload.ts` | 轻量搜索投影、分页 IPC 与 bridge |
| `src/main/sqliteStore.ts` | 老库 sequence 迁移后创建消息顺序复合索引 |
| `src/shared/cowork/search.ts` | 搜索投影、绝对下标和 keyset cursor 契约 |

预计新增或扩展测试：

| 文件 | 覆盖 |
| --- | --- |
| `src/renderer/components/cowork/conversationSearch.test.ts` | 搜索范围、规范化、排序、重复命中、大小写和 Markdown |
| `src/renderer/components/cowork/conversationSearchHighlight.test.ts` | DOM Range、跨文本节点、清理和 fallback |
| `src/renderer/components/cowork/CoworkConversationSearch.test.tsx` | 输入、键盘、IME、disabled、计数与关闭 |
| 现有 shortcut/App 测试 | 会话内搜索与历史任务搜索的上下文路由 |
| 现有 Cowork 分页测试 | 未加载消息定位和 session 切换竞态 |

本功能不修改 SQLite 表字段、OpenClaw runtime 或补丁；仅增加可重复执行的消息顺序索引迁移。

## 9. 测试与验证计划

### 9.1 单元测试

1. 中文、英文和中英混合查询。
2. 英文大小写不敏感。
3. 同一消息零次、一次和多次非重叠命中。
4. 查询包含 `.`, `*`, `[`, `?`, `\` 等正则特殊字符时按字面匹配。
5. user display 清理 IM 系统包装后只搜索可见正文。
6. assistant thinking、tool、system 不进入结果。
7. Markdown 标题、列表、强调、链接、inline code、fenced code 的搜索文本。
8. 结果 `absoluteMessageIndex` 与包含工具消息的完整数组下标一致。
9. 异步旧查询结果不会覆盖新查询。
10. session 切换后旧定位任务不操作新会话 DOM。
11. 超过 10,000 个命中时停止分配新结果，并显示带 `+` 的上限计数。

### 9.2 组件测试

1. 打开后自动聚焦；再次触发快捷键选中查询。
2. Enter 下一处，Shift+Enter 上一处，并在首尾循环。
3. Esc 和关闭按钮清理状态。
4. IME composing 期间不导航、不关闭。
5. 空查询、loading、无结果、有结果和 error 状态。
6. 箭头 disabled 与 `aria-live` 文案正确。

### 9.3 手工验证矩阵

| 平台/状态 | 场景 |
| --- | --- |
| macOS，侧栏展开 | 搜索框右侧布局、窗口拖拽、输入和关闭 |
| macOS，侧栏折叠 | 红黄绿按钮避让、标题截断、搜索宽度 |
| Windows，侧栏展开 | 独立窗口标题栏与会话搜索互不覆盖 |
| Windows，侧栏折叠 | Windows 顶栏按钮、新建按钮和会话搜索均可用 |
| Codex 截图视觉对照 | 两行共用外轮廓、分隔线、图标顺序、计数位置、圆角、阴影和高亮强弱一致 |
| ArtifactPanel 关闭 | 正常按钮与搜索互相恢复 |
| ArtifactPanel 普通分栏 | 面板内容保持、标题栏操作临时替换 |
| ArtifactPanel 全屏 | 搜索打开时恢复分栏，结果可见 |
| 长会话 | 命中当前窗口外的早期消息 |
| 长 turn | LazyRenderTurn 占位目标强制渲染 |
| 超大 Markdown | 命中轻量预览省略的中间内容 |
| streaming | 搜索历史结果不被自动滚底打断，计数节流更新 |
| 明暗主题 | 当前/普通高亮对比度和搜索控件视觉 |

### 9.4 质量门禁

- 运行相关 Vitest，例如 `npm test -- conversationSearch`。
- 对所有修改和新增的 TypeScript/TSX 文件运行仓库 CI 等价 ESLint，零 warning。
- 运行 `npm run build` 验证 renderer bundle。
- 使用 `npm run electron:dev` 手工验证标题栏拖拽、快捷键、分页定位和 ArtifactPanel 交互。
- Windows 布局必须在 Windows 实机或等价打包环境验证，不能只根据 macOS CSS 推断。

## 10. 验收标准

1. 当前打开 Cowork 主会话时，`Cmd/Ctrl+F` 打开标题栏右上角的当前对话搜索，而不是历史任务弹窗。
2. 没有当前会话或处于管理页时，`Cmd/Ctrl+F` 仍打开现有历史任务搜索。
3. 搜索打开期间，标题栏原 ArtifactPanel 操作区被完整替换；关闭后原状态恢复。
4. 搜索控件按参考 Codex 截图还原：两行共享一个右上角浮层外轮廓；第一行为搜索图标、无边框输入、
   竖分隔线和关闭按钮；第二行为左侧上一处/下一处和右侧结果计数，第二行不推挤消息布局。
5. Enter、Shift+Enter、箭头按钮、Esc 和关闭按钮行为符合本文定义，IME 组合态不误触发。
6. 搜索覆盖完整会话的 user 与正式 assistant 文本，并排除 thinking、tool 和 system 内容。
7. 同一消息多次出现时结果计数正确，上一处/下一处按消息顺序和出现顺序循环。
8. 命中未加载消息时能自动加载目标窗口、渲染目标 turn，并把当前命中滚动到可视区域。
9. 命中大 Markdown 被省略的中段内容时能够完整显示并高亮当前结果。
10. 当前命中呈现类似参考截图的高饱和橙底深色文字，其他已渲染命中为较弱的同色系；关闭搜索后
    所有高亮被清理。
11. 搜索期间 streaming 不会把用户自动拉回底部，新结果更新不重置仍有效的当前命中。
12. macOS 侧栏展开/折叠和 Windows 自绘标题栏下均无窗口控制遮挡，输入区域可点击且不触发窗口拖拽。
13. ArtifactPanel 普通分栏保持打开；全屏状态在搜索打开时恢复为分栏，搜索关闭后不自动重新全屏。
14. 日志和埋点不包含查询正文、命中文本或消息内容。
15. 相关 Vitest、触及文件 ESLint 和 renderer build 通过，手工验证未发现现有历史任务搜索、消息 rail、
    自动滚动、Markdown、ArtifactPanel 或输入快捷键回归。
16. 在相同窗口宽度下与用户提供的 Codex 截图并排核对时，搜索浮层的位置、约 340px 宽度、两行层级、
    分隔线、按钮顺序、结果计数位置、圆角和轻阴影无明显结构性差异；macOS 和 Windows 仅锚点不同，
    搜索框内部 UI 保持一致。
