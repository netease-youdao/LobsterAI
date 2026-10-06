# Artifact 右侧预览工具栏分享与部署设计文档

## 1. 概述

### 1.1 背景

LobsterAI 已经在对话中的 `ArtifactPreviewCard` 提供两类发布入口：

- 可分享文件显示“分享”，通过 `ArtifactFileShareController` 创建或管理分享；
- `local-service` 显示“部署”，通过 `ArtifactPanel` 完成订阅校验、项目目录解析、站点配额预检、项目分析、打包上传和部署状态管理。

用户点击卡片进入右侧预览后，普通 Artifact 工具栏只有预览/代码切换、刷新、复制、外部打开和文件列表等操作，浏览器工具栏只有导航、地址栏、标注和浏览器菜单。用户如果在预览中确认内容后才决定分享或部署，必须返回对话重新寻找原卡片，操作路径长；当卡片已经滚出可视区域或同一任务产生多个 Artifact 时，也容易操作错对象。

右侧预览存在两种不同承载方式：

| 预览对象 | 右侧承载方式 | 当前工具栏 |
| --- | --- | --- |
| 图片、SVG、文档、Markdown、Mermaid 等 Artifact | `ArtifactPanel` 的文件预览头部 | 文件名 + 文件操作 |
| HTML 文件 | `ArtifactPanel` 的 Browser tab | 浏览器导航工具栏 |
| 本地 Web 服务 | `ArtifactPanel` 的 Browser tab | 浏览器导航工具栏 |

因此，本功能不能只在普通文件头部增加一个按钮；必须同时处理文件预览工具栏和浏览器工具栏，才能覆盖卡片已有的文件分享与服务部署能力。

### 1.2 目标

1. 用户在右侧预览当前文件时，可以直接创建或管理该文件的分享。
2. 用户在右侧浏览器预览本地服务时，可以直接打开该服务的部署创建或管理流程。
3. HTML 文件在浏览器预览中仍可分享原始 HTML Artifact。
4. 新入口复用预览卡片现有的分享、部署、订阅和配额链路，不新增第二套弹窗、状态或 IPC。
5. 卡片与右侧工具栏对同一对象使用完全一致的可用性规则和业务结果。
6. 工具栏在窄侧栏下仍保持可用，并具备键盘、Tooltip、禁用态和中英文文案。
7. 埋点能够区分预览卡片、普通文件工具栏和浏览器工具栏入口。

### 1.3 非目标

1. 不删除或隐藏预览卡片上的现有分享、部署按钮。
2. 不新增分享或部署后端接口，不改变上传协议、分享权限、部署配额和站点生命周期。
3. 不支持分享用户在浏览器地址栏中访问的任意网页。
4. 不把 HTML 文件“分享”改成站点部署，也不把本地服务“部署”改成普通文件分享。
5. 不新增从站点管理页发起部署的入口。
6. 不在本次需求中拆分整个 `ArtifactPanel.tsx`；仅做支撑入口复用所需的局部调整。

## 2. 现状与设计决策

### 2.1 文件分享现状

`ArtifactPreviewCard` 通过以下规则显示分享按钮：

```ts
Boolean(artifactFileShare) && isArtifactFileShareable(artifact)
```

当前 `isArtifactFileShareable()` 支持：

| Artifact 类型 | 可分享来源 |
| --- | --- |
| `html` | 必须有 `filePath` |
| `image` | `filePath`、内联内容或受支持的远端图片 URL |
| `svg` | `filePath`、内联内容或受支持的远端 URL |
| `document` | `filePath` 或内联内容 |
| `markdown` | `filePath` 或内联内容 |
| `mermaid` | `filePath` 或内联内容 |

分享创建、已有分享查询、权限修改、停止/恢复、更新文件、订阅拦截和反馈弹窗已经集中在 `ArtifactFileShareController`。右侧栏必须调用同一个 controller，不得重新接入 `ArtifactPanel.tsx` 中历史遗留的 HTML 分享状态。

### 2.2 本地服务部署现状

预览卡片点击“部署”后，由 `CoworkSessionDetail.handleDeployLocalServiceArtifact()` 生成一次性 `LocalServiceDeploymentRequest`，再由 `ArtifactPanel.handleShareLocalServiceDeployment()` 执行实际流程。

`ArtifactPanel` 已经具备从 Browser tab 当前 URL 识别 localhost 服务、恢复项目目录、查询已有部署和维护部署弹窗的能力。右侧浏览器工具栏应直接调用 `ArtifactPanel` 内的同一部署入口，不应再构造一条绕经预览卡片的请求。

### 2.3 入口与业务逻辑分层

采用“多个入口、一个动作控制器”的结构：

```text
对话预览卡片 ───────────────┐
普通文件预览工具栏 ─────────┼─> ArtifactFileShareController.openShare()
HTML 浏览器预览工具栏 ──────┘

对话本地服务卡片 ───────────┐
本地服务浏览器工具栏 ───────┴─> ArtifactPanel.handleShareLocalServiceDeployment()
```

工具栏只负责：

- 判断当前对象是否应显示操作；
- 展示按钮、Tooltip，以及用户主动操作触发的短暂忙碌态和禁用态；
- 把当前对象及入口来源传给既有控制器。

订阅校验、已有记录查询、项目分析、打包上传、配额校验和错误弹窗继续由既有业务层负责。

## 3. 用户场景

### 场景 1：在普通文件预览中分享

**Given** 用户从对话卡片打开一个可分享的图片、SVG、文档、Markdown 或 Mermaid Artifact

**When** 用户点击右侧文件预览工具栏的分享按钮

**Then** 打开与预览卡片相同的创建分享或分享设置弹窗，目标为当前预览 Artifact。

### 场景 2：在代码视图中分享当前文件

**Given** 用户把当前 Artifact 从预览切换到代码视图

**When** 用户点击工具栏分享按钮

**Then** 仍分享该 Artifact 的原始来源，不分享代码视图生成的 DOM 或临时文本。

### 场景 3：在浏览器中分享 HTML 文件

**Given** 用户通过 HTML Artifact 打开右侧内置浏览器预览

**When** 用户点击浏览器工具栏分享按钮

**Then** 分享 `browserHtmlArtifactId` 对应的原始 HTML Artifact，复用其本地文件路径和依赖打包逻辑，不抓取 webview 当前页面。

### 场景 4：在浏览器中部署本地服务

**Given** 浏览器当前地址是带有效端口的 `localhost`、`127.0.0.1` 或 IPv6 loopback 服务

**When** 用户点击浏览器工具栏部署按钮

**Then** 打开与预览卡片相同的部署流程；如果已有部署则打开其状态/设置，如果没有则进入项目目录解析和部署确认。

### 场景 5：浏览器离开本地服务

**Given** 用户先预览本地服务，随后导航到外部网站

**When** 当前 URL 不再是本地服务 URL

**Then** 部署按钮立即隐藏，不能继续用旧的本地服务上下文部署外部页面。

### 场景 6：订阅或配额不满足

**Given** 用户未登录、没有有效订阅，或站点部署额度已满

**When** 用户从右侧工具栏点击分享或部署

**Then** 展示与预览卡片入口相同的订阅提示或站点替换流程，不绕过任何校验。

## 4. 功能需求

### FR-1：普通文件工具栏分享入口

当 `selectedArtifact` 满足以下全部条件时，在文件预览头部展示分享按钮：

1. 当前存在 `ArtifactFileShareController`；
2. `isArtifactFileShareable(selectedArtifact) === true`；
3. 当前没有因为 Artifact 切换而失去目标对象。

按钮规则：

- 使用现有 `ShareIcon`；
- 使用 32×32 的图标按钮和 16×16 图标，视觉与浏览器工具栏按钮一致；
- `title` 和 `aria-label` 使用 `t('htmlShare')`；
- 放在文件名后的主操作区、更多操作菜单之前；
- 预览和代码视图都显示；
- 点击后调用 `openShare(selectedArtifact, entryContext)`。

不支持分享的 `code`、`text`、`video`、`local-service` 等类型不显示按钮，不展示点击后再报错的空入口。

### FR-2：HTML 浏览器工具栏分享入口

Browser tab 同时满足以下条件时展示分享按钮：

1. `browserHtmlArtifactId` 能在当前 session 的 artifacts 中解析到 Artifact；
2. Artifact 类型为 `html`；
3. `isArtifactFileShareable(browserHtmlArtifact) === true`；
4. 当前 Browser tab 仍保留该 HTML preview 的 `browserHtmlArtifactId`，而不是已导航离开或切换为本地服务上下文。

按钮位于地址栏之后、标注按钮之前。点击后传入原始 `browserHtmlArtifact`。

不得：

- 从 webview 执行脚本读取页面 HTML 后创建分享；
- 分享预览服务的 `127.0.0.1` 内部 URL；
- 在用户输入任意外部 URL 后继续把该网页当作 HTML Artifact 分享。

### FR-3：本地服务浏览器工具栏部署入口

Browser tab 当前 URL 能由现有 `parseLocalServiceUrl()` 解析为本地服务时展示部署按钮。支持的 host 与当前逻辑保持一致：

```text
localhost
127.0.0.1
0.0.0.0
[::1] / ::1
```

URL 必须包含 1～65535 的显式端口。

右栏按钮先构建与卡片入口一致的目录识别上下文：

1. 当前 origin 与 `browserLocalServiceContext` 相同：复用其中的 `artifactId`、`projectDirectory` 和 `projectCandidates`，并从对应 `local-service` Artifact 补充标题；
2. 把 session `workingDirectory` 作为工作区候选传入；
3. 缓存目录不由工具栏直接读取，继续由现有 `resolveNodeDeploymentProjectDirectory()` 按 session + local service origin 读取。

`resolveNodeDeploymentProjectDirectory()` 调用主进程 `detectProjectCandidates()`，按以下阶段顺序返回候选；候选不进行跨阶段的全局置信度重排，第一个通过项目分析的目录即被采用：

| 顺序 | 来源 | 识别方式 |
| --- | --- | --- |
| 1 | 监听端口的进程目录 | 从服务 URL 解析端口，macOS/Linux 使用 `/proc` 或 `lsof` 找到监听 PID 及 cwd，再向上寻找最近的可运行 `package.json`；如果不是 Node 项目，则向上寻找静态站点 `index.html` |
| 2 | 当前 session/Artifact 上下文 | 先使用明确的 `projectDirectory`，再按原顺序检查 `projectCandidates`；候选可来自 Artifact 元数据、工具工作目录、`cd`/`pwd` 结果或消息中的标注路径 |
| 3 | 上次确认目录 | 读取当前 session + local service origin 对应的本地缓存 |
| 4 | 当前工作区 | 从 session `workingDirectory` 向上寻找最近的可运行 `package.json` 或静态站点 `index.html` |

Windows 当前不执行“端口 → PID → cwd”识别，直接从第 2 阶段开始。

当前实现不会递归扫描整个工作区的子目录，避免在大型仓库中产生高开销和误选；工作区无法命中时由用户在部署弹窗中明确选择目录。

每个候选都必须通过现有 `analyzeProjectDirectory()` 校验：

- 路径存在且为目录；
- 不是磁盘根目录、用户 Home、Desktop/Documents/Downloads、系统临时目录等受保护根目录；
- Node 项目包含 `package.json`，并具有受支持的 build/start/serve/dev 能力；
- 无 `package.json` 的纯静态项目至少包含 `index.html`；
- 本地服务 URL 具有有效端口；
- 没有阻断部署的分析错误。

所有候选均失败时，部署弹窗使用 session `workingDirectory` 作为待确认值并展示分析 blocker，提交按钮保持禁用；用户必须改选有效服务目录后才能继续，不能直接打包一个未通过分析的目录。

点击按钮调用：

```ts
handleShareLocalServiceDeployment({
  localService,
  projectDirectory,
  projectCandidates,
});
```

不得从工具栏复制订阅、配额、已有部署查询或打包逻辑。

### FR-4：浏览器工具栏只显示一个发布主操作

Browser tab 的分享与部署按钮互斥：

| 当前上下文 | 工具栏操作 |
| --- | --- |
| 受管 HTML Artifact 预览 | 分享；内部 preview server 即使使用 loopback URL 也不能被识别为可部署服务 |
| 当前 URL 为本地服务 | 部署 |
| 普通外部网页、空白页、无效 localhost URL | 不显示 |

如果状态数据短暂冲突，以受管 HTML Artifact 身份为优先，因为 HTML preview session 本身使用内部 loopback 服务；只有 `browserHtmlArtifactId` 已清除后，loopback URL 才能作为用户本地服务参与部署识别。这样可以避免把 LobsterAI 的 HTML 预览服务误当作用户项目部署。

### FR-5：状态与重复点击

#### 文件分享

`ArtifactFileShareController` 继续作为弹窗和异步状态的唯一来源。工具栏按钮不展示“已分享”等常驻业务状态；点击只触发 `openShare()`，由 controller 查询后进入首次分享或已有分享管理。controller 已在处理同一来源的准备请求时应复用或串行化请求，不创建两个分享记录。

#### 服务部署

部署按钮是固定操作入口，不展示首次部署、已有部署、停止、失败等常驻业务状态。已有部署预查询可以继续用于缩短点击后的等待时间，但不得改变按钮图标、Tooltip、颜色、禁用态或忙碌态。

只有用户主动点击后，部署按钮才按当前 `ArtifactPanel` 交互状态提供短暂反馈：

| 交互状态 | 按钮行为 |
| --- | --- |
| 未点击或仅后台预查询 | 固定显示部署 icon，Tooltip 为“部署”，保持可点击 |
| 点击后查询服务端 | 禁用，显示轻量 spinner，Tooltip 为“正在检查…” |
| 项目分析、构建、上传或部署中 | 禁用，Tooltip 使用现有阶段文案 |
| 服务端返回已有部署 | 恢复固定部署 icon，并打开已有部署状态/设置弹窗 |
| 服务端确认没有部署 | 恢复固定部署 icon，并进入首次部署流程 |
| 部署弹窗已经打开且属于当前服务 | 再次点击只把现有弹窗置于可见状态 |

按钮禁用条件必须与 `handleShareLocalServiceDeployment()` 的并发保护一致，不能出现 UI 可点击但 handler 静默返回的长期状态。

### FR-6：对象切换与异步结果隔离

1. 用户切换 Artifact 后，新点击必须只作用于新的 `selectedArtifact`。
2. 分享准备期间切换 Artifact 不自动关闭已经打开的分享弹窗；弹窗继续明确显示其目标文件名。
3. 部署查询期间切换到另一个本地服务时，旧请求结果不得覆盖新服务状态。继续使用现有 run id 和 lookup key 隔离。
4. 当前 URL 离开 localhost 后，部署按钮立即消失；已经主动打开的部署弹窗不因浏览器导航被强制关闭。
5. session 切换后，入口只能引用新 session 的 Artifact、浏览器上下文和项目目录缓存。

### FR-7：布局与可访问性

1. 新按钮使用图标模式，不在常规工具栏中常驻文字，避免压缩文件名或浏览器地址栏。
2. 普通文件工具栏分享按钮和浏览器工具栏按钮恢复使用 28×28 点击热区；分享图标保持 16×16，部署和标注图标使用 18×18 的光学尺寸，并使用相同圆角、hover、focus-visible 和 disabled 规则。
3. 分享使用现有分享图标；部署复用现有实心 `ServiceDeploymentIcon`，保持各部署入口的产品识别一致性。
4. 分享和部署按钮常态使用透明背景与 `text-secondary`，与导航、刷新、标注等工具栏按钮一致；不得使用会被误解为“已发布”或选中状态的常驻主色背景。只有 hover、focus-visible 和用户点击后的短暂忙碌态提供视觉反馈。
5. 按钮必须是 `type="button"`，支持 Tab 聚焦、Enter/Space 触发，并提供 `aria-label`。
6. 用户主动操作产生的忙碌态保留可读 Tooltip，不只用动画表达状态；后台预查询不得让按钮自动进入忙碌态。
7. 侧栏最小宽度下仍保留发布按钮；只允许压缩地址栏或文件名，不把发布按钮放入更多菜单。
8. 浏览器工具栏将“分享/部署、标注、更多”组成固定右侧操作组，顺序不可变，组内间距为 4px；地址栏与操作组继续使用工具栏主间距，避免图标松散或位置跳动。
9. 浏览器工具栏参考 Codex 的紧凑密度使用 40px 高度，地址栏为 28px；导航、发布、标注和更多按钮均为 28×28，窄侧栏下优先压缩地址栏，不缩小按钮。
10. 分享图标作为视觉基准保持 16×16；标注图标扩大轮廓并使用 18×18 画布；部署保留原有实心图标并使用 18×18 画布，向下做 1.5px 光学校正，使部署与标注的可见轮廓中心落在同一水平线上。
11. 地址栏常态不展示边框或填充，通过留白融入工具栏；hover 时显示浅色背景，focus 时增加边框和浅色背景，在降低框体感的同时保留输入状态反馈。
12. 对话中的预览卡片继续保留分享和部署入口，但不再使用常驻主色填充；按钮采用与“打开方式”一致的透明浅色背景、细边框、前景色文字和浅色 hover，降低发布操作对卡片内容的视觉压迫。卡片部署图标保持 16×16，并向下做 1px 光学校正，使其与“部署”文字视觉居中；分享图标不调整。

### FR-8：国际化

优先复用：

| key | 中文 | 英文 |
| --- | --- | --- |
| `htmlShare` | 分享 | Share |
| `nodeDeploymentProgressDeploy` | 部署 | Deploy |
| `nodeDeploymentButtonChecking` | 正在检查… | Checking… |
| 现有各部署阶段 key | 现有文案 | 现有文案 |

工具栏统一显示“部署”，不新增“已部署”“管理部署”“重新部署”等按钮文案；由服务端查询结果和弹窗内容说明创建、管理或恢复状态。

### FR-9：埋点

`ArtifactFileShareController.openShare()` 当前把来源固定记录为 `conversation_artifact_card`。新增入口后必须让调用者传入入口上下文，不能把右侧工具栏点击误报为卡片点击。

建议在 Renderer 内集中定义：

```ts
export const ArtifactPreviewActionSource = {
  ConversationCard: 'conversation_artifact_card',
  ArtifactPanel: 'artifact_panel',
  ArtifactBrowser: 'artifact_browser',
} as const;

export const ArtifactPublishEntryPoint = {
  PreviewCard: 'preview_card',
  ArtifactToolbar: 'artifact_toolbar',
  BrowserToolbar: 'browser_toolbar',
} as const;
```

分享事件为兼容现有报表，可先保留 `actionType = share_html_click`，新增：

```text
source
entryPoint
shareSourceType
```

部署按钮新增 `actionType = deployment_entry_click`，至少包含：

```text
source=artifact_browser
entryPoint=browser_toolbar
browserUrlType=localhost
hasArtifactContext
hasProjectDirectory
hasExistingDeployment
```

不得上报文件路径、项目目录、页面 URL、分享链接、分享码或部署日志。

## 5. 实现方案

### 5.1 扩展分享控制器入口参数

把 controller API 从：

```ts
openShare(artifact)
```

调整为：

```ts
openShare(artifact, {
  source: ArtifactPreviewActionSource,
  entryPoint: ArtifactPublishEntryPoint,
})
```

调用方：

| 调用位置 | `source` | `entryPoint` |
| --- | --- | --- |
| `ArtifactPreviewCard` | `ConversationCard` | `PreviewCard` |
| 普通文件预览头部 | `ArtifactPanel` | `ArtifactToolbar` |
| HTML 浏览器工具栏 | `ArtifactBrowser` | `BrowserToolbar` |

入口参数只用于埋点和诊断，不参与分享来源 key、鉴权或业务判断。

### 5.2 普通文件工具栏接入

`ArtifactPanel` 位于 `ArtifactFileShareProvider` 内部，可以直接调用 `useOptionalArtifactFileShare()`。

新增派生状态：

```ts
const artifactFileShare = useOptionalArtifactFileShare();
const showArtifactShareAction = Boolean(
  selectedArtifact &&
  artifactFileShare &&
  isArtifactFileShareable(selectedArtifact)
);
```

点击时使用当前闭包中的 `selectedArtifact`，调用 controller。分享按钮保持为主工具栏直接操作，不放进现有 `...` 菜单。

`ArtifactPanel.tsx` 中旧的 `htmlShareDialog`、`htmlSharePendingRequest` 等状态不作为新入口依赖。若后续确认已经没有调用方，可单独设计清理任务；本功能不夹带大范围删除。

### 5.3 Browser tab 发布操作模型

发布对象由 `ArtifactPanel` 统一计算，因为它同时持有：

- `browserHtmlArtifact`；
- `browserUrl` / `browserAddress`；
- `browserLocalServiceContext`；
- 项目目录缓存；
- `nodeDeploymentLookup` 与部署弹窗状态；
- 文件分享 controller。

为避免继续把显示矩阵堆进大型组件，建议新增一个仅负责“当前工具栏应该对应哪个发布目标”的纯策略模块 `artifactToolbarPublishPolicy.ts`。它集中提供 `ArtifactToolbarPublishActionKind` 常量和 `resolveArtifactToolbarPublishTarget()`，输入已经解析好的 Artifact/本地服务上下文，输出 `share`、`deploy` 或 `none`；不持有 React 状态，不调用 IPC，也不处理订阅与部署流程。`ArtifactPanel` 再为策略结果绑定回调和忙碌态。

向 `BrowserTabContent` 增加一个窄的展示模型，而不是把业务对象和服务 API 全部下放：

```ts
interface BrowserPublishAction {
  kind: typeof BrowserPublishActionKind.Share | typeof BrowserPublishActionKind.Deploy;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
}
```

`BrowserPublishActionKind` 使用 `as const` 集中定义。`BrowserTabContent` 只渲染按钮和调用 `onClick`，不查询分享、部署或订阅状态。

### 5.4 HTML 预览归属校验

`CoworkSessionDetail.handleBrowserPreviewUrlChange()` 已经把最新 URL 与 session 保存的 HTML preview URL 比较。导航离开受管 preview session 时，现有逻辑会销毁该 preview session，并清除 `browserHtmlPreviewArtifactId`。

因此，`ArtifactPanel` 以以下条件识别可分享的 HTML 浏览器上下文：

```ts
Boolean(
  isBrowserTabActive &&
  browserHtmlArtifact?.type === ArtifactTypeValue.Html &&
  isArtifactFileShareable(browserHtmlArtifact) &&
  !browserLocalServiceContext
)
```

工具栏不自行根据地址栏展示值反推文件身份。用户导航离开后分享按钮消失；需要再次分享原文件时，应重新从该 HTML Artifact 卡片或文件列表打开预览。

### 5.5 本地服务部署上下文构建

在 `ArtifactPanel` 内新增 `handleDeployBrowserLocalService()`：

1. 读取当前解析出的 `browserLocalService`；
2. 验证点击瞬间 URL 仍为相同 origin；
3. 合并匹配的 `browserLocalServiceContext` 与对应 Artifact 元数据；
4. 记录浏览器工具栏入口埋点；
5. 调用 `handleShareLocalServiceDeployment()`。

`handleShareLocalServiceDeployment()` 继续调用现有 `resolveNodeDeploymentProjectDirectory()`，由它统一完成监听进程、上下文候选、缓存和工作区识别。入口不再经过 `CoworkSessionDetail.localServiceDeploymentRequest`，因为当前 `ArtifactPanel` 已拥有完整的浏览器和部署上下文。卡片入口继续保留原请求机制。

### 5.6 异步与弹窗归属

- 文件分享继续使用 controller 的 generation id、lookup key 和 mutation barrier。
- 部署继续使用 `nodeDeploymentActionRunIdRef`、`nodeDeploymentLookupRef` 和 local service lookup key。
- 新按钮不新增独立 loading state；只消费用户主动点击后产生的现有交互状态，不消费后台预查询状态。
- 分享弹窗由 `ArtifactFileShareProvider` portal 到 `document.body`。
- 部署、订阅和配额弹窗继续由 `ArtifactPanel` 渲染，层级保持现状。

### 5.7 后端与 IPC

本功能不新增后端或 IPC。

| 功能 | 复用接口 |
| --- | --- |
| 文件分享 | `window.electron.htmlShare.*` |
| 项目候选与分析 | `window.electron.shareDeployment.detectProjectCandidates/analyzeProjectDirectory` |
| 已有部署查询 | `window.electron.shareDeployment.getByLocalService` |
| 创建部署 | 现有 Node/static deployment IPC |
| 配额预检 | `window.electron.sites.getDeploymentQuota` |

## 6. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| Artifact 类型支持预览但不支持分享 | 不显示分享按钮 |
| HTML 只有内联内容、没有 `filePath` | 沿用当前规则，不显示分享按钮 |
| HTML preview session 创建失败 | 不显示浏览器分享按钮，保留现有失败 toast |
| HTML 预览导航到外部页面 | 隐藏分享按钮，不抓取外部页面 |
| HTML 预览导航离开后点击后退 | 原 preview session 已按现有逻辑销毁，不恢复分享按钮；重新打开原 HTML Artifact 后恢复 |
| localhost URL 没有端口或端口非法 | 不显示部署按钮 |
| 当前 URL 是部署后的公网地址 | 不显示部署按钮；公网站点通过站点管理能力管理 |
| 本地服务离线但 URL 仍有效 | 允许进入现有部署流程；项目解析或检查结果给出明确错误 |
| Windows 无法根据监听端口读取进程 cwd | 使用 Artifact/session 上下文、缓存和工作区候选，不把端口识别失败视为最终失败 |
| 项目目录未知 | 进入现有候选发现/选择流程 |
| 所有自动候选都未通过分析 | 弹窗展示工作区兜底值和 blocker，部署提交保持禁用，等待用户选择有效目录 |
| 已存在 live 部署 | 点击后打开现有部署状态/权限设置 |
| 已停止 Node 部署 | 沿用现有“需要重新部署”逻辑 |
| 部署额度已满 | 在打包上传前展示现有站点替换弹窗 |
| 用户快速重复点击 | 分享由 controller 串行化；部署按钮禁用并由 run id 防重 |
| 分享或部署过程中切换 session | 旧请求不能更新新 session 的工具栏状态 |
| 侧栏宽度最小 | 保留一个图标发布按钮，文件名/地址栏优先收缩 |
| controller 或 preload API 不可用 | 不显示文件分享入口；部署沿用现有明确失败反馈 |

## 7. 涉及文件

| 文件 | 修改 |
| --- | --- |
| `src/renderer/components/artifacts/ArtifactPanel.tsx` | 计算普通文件与 Browser tab 发布动作；复用分享 controller 和部署 handler；传递浏览器按钮模型 |
| `src/renderer/components/artifacts/ArtifactFileShareController.tsx` | `openShare` 接收入口来源，修正工具栏埋点归属 |
| `src/renderer/components/artifacts/ArtifactPreviewCard.tsx` | 调用扩展后的 `openShare`，显式传预览卡片入口 |
| `src/renderer/components/artifacts/artifactAnalytics.ts` | 集中定义 action source / publish entry point 常量和类型 |
| `src/renderer/components/artifacts/artifactFileSharePolicy.ts` | 继续作为所有文件分享入口的统一可用性规则；原则上无需改业务范围 |
| 建议新增 `src/renderer/components/artifacts/artifactToolbarPublishPolicy.ts` | 集中普通文件、HTML preview、本地服务和外部网页的工具栏发布目标解析 |
| `src/renderer/services/i18n.ts` | 复用现有 key；仅在新增“管理部署”等文案时补齐中英文 |
| `src/renderer/components/artifacts/artifactFileSharePolicy.test.ts` | 保证工具栏与卡片依赖的分享范围一致 |
| 建议新增 `src/renderer/components/artifacts/artifactToolbarPublishPolicy.test.ts` | 覆盖普通文件、HTML preview、本地服务和外部网页的动作解析 |

`ArtifactPanel.tsx` 已经很大。本次保持部署业务逻辑原位，只下放一个窄的 `BrowserPublishAction` 展示模型；如果实现中需要继续增加多种发布动作，再单独提出 `useArtifactPublishActions` 或工具栏组件提取方案，不在本需求内做整体拆分。

## 8. 实施步骤

1. 为分享 controller 增加入口上下文，并更新预览卡片调用方。
2. 增加发布动作来源和入口常量，保持现有埋点事件兼容。
3. 在普通文件预览头部接入分享按钮。
4. 在 `ArtifactPanel` 构建 HTML 分享和本地服务部署的 Browser publish action。
5. 扩展 `BrowserTabContent` props，在地址栏后渲染互斥的分享/部署按钮。
6. 补齐纯策略单元测试、现有分享策略回归测试和 changed-file ESLint。
7. 启动 Electron，按普通文件、HTML 文件、本地服务三条路径做人工验证。

## 9. 验证计划

### 9.1 单元测试

1. 支持分享的 Artifact 在普通文件工具栏解析为 `share`。
2. 不支持分享的 Artifact 不生成发布动作。
3. 受管 HTML preview session 生成 `share`，导航到外部 URL 并清除 Artifact 关联后不生成。
4. localhost、IPv4 loopback、IPv6 loopback 且端口有效时生成 `deploy`。
5. 外部 URL、无端口 localhost、非法端口不生成 `deploy`。
6. 受管 HTML 上下文与内部 localhost preview URL 同时存在时只生成 `share`。
7. 分享 controller 接收到不同 entry point 时上报正确 source，业务请求保持一致。
8. 用户点击后的部署忙碌状态映射为禁用/忙碌按钮，后台预查询不改变按钮展示。

### 9.2 手工验证

1. 分别预览 PNG、SVG、PDF/DOCX、Markdown、Mermaid，确认分享按钮和卡片入口打开同一类弹窗。
2. 在预览/代码视图之间切换，确认分享目标不变。
3. 预览 HTML 文件，确认浏览器工具栏出现分享按钮并分享原始文件。
4. 从 HTML 预览导航到外部网页，确认分享按钮消失；重新打开原 HTML Artifact 后恢复。
5. 打开本地 Vite/Node 服务，确认浏览器工具栏出现部署按钮。
6. 对未部署、已部署、已停止和部署失败的服务分别点击，确认进入正确弹窗状态。
7. 验证未登录、无订阅、额度已满、打包失败和上传失败流程与卡片入口一致。
8. 连续点击按钮、切换 Artifact、切换服务和切换 session，确认无重复记录和串状态。
9. 在最小侧栏宽度、展开面板、浅色/深色模式下检查布局、Tooltip 和 focus-visible。
10. 用键盘 Tab + Enter/Space 完成分享和部署入口操作。
11. 后台预查询首次部署或已有部署期间，确认按钮始终显示固定部署 icon 和“部署”Tooltip；只有点击后查询或提交期间显示 spinner。

### 9.3 工程验证

实现后至少执行：

```bash
npm test -- artifactFileSharePolicy
npm test -- artifactToolbarPublishPolicy
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 \
  src/renderer/components/artifacts/ArtifactPanel.tsx \
  src/renderer/components/artifacts/ArtifactFileShareController.tsx \
  src/renderer/components/artifacts/ArtifactPreviewCard.tsx \
  src/renderer/components/artifacts/artifactAnalytics.ts
npm run build
```

## 10. 验收标准

1. 所有当前可分享文件在右侧普通预览工具栏都有分享按钮，支持范围与预览卡片完全一致。
2. HTML 文件在右侧浏览器预览工具栏有分享按钮，分享对象是原始 Artifact，不是 webview 页面或内部 preview URL。
3. 本地服务在右侧浏览器工具栏有部署按钮，点击后复用现有部署创建/管理流程。
4. 外部网页、无效 localhost 地址和不支持分享的 Artifact 不出现错误入口。
5. 卡片和右侧工具栏复用相同订阅校验、分享设置、部署查询、配额预检、打包上传和错误处理。
6. Browser tab 同一时刻最多显示一个分享或部署主操作。
7. 重复点击、对象切换和 session 切换不会创建重复分享/部署，也不会把异步结果写到错误对象。
8. 新按钮在最小侧栏宽度、浅色/深色模式和键盘操作下可用。
9. 中英文文案完整，不新增硬编码用户可见字符串。
10. 埋点能区分预览卡片、普通文件工具栏和浏览器工具栏，且不采集路径、URL、分享码等敏感信息。
11. 不新增后端接口或 IPC，不改变现有分享和部署协议。
12. 预览卡片上的原分享、部署入口继续正常工作。
13. 右侧栏按钮不展示首次/已有发布等常驻业务状态；后台预查询不改变按钮展示，点击后的查询和提交可以显示短暂加载态。
