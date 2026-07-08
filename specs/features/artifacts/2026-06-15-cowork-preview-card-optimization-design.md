# 对话窗预览卡片优化设计文档

## 1. 概述

### 1.1 问题/背景

当前 Cowork 对话窗会把会话中发现的文件、网页、本地服务和媒体转成 Artifact，并在 assistant turn 底部展示 `ArtifactPreviewCard`。现有卡片已经能打开右侧预览面板或本地应用，但展示方式和产品 PRD 有差异：

1. 卡片默认背景偏灰，和输入框、消息区视觉层级不一致。
2. 多数卡片使用通用类型图标，文件格式识别度不够。
3. HTML 网站类输出没有突出“网站名称”，仍容易被 `index.html` 等文件名主导。
4. 多个文件一次性平铺展示，文件较多时占用对话空间。
5. “打开方式”菜单需要保持现有系统应用和打开所在文件夹能力，但视觉和 HTML 特殊入口需要统一。
6. 已有预览卡片之间的标题、副标题、图标和操作区样式不一致。

本设计基于 PRD 图片《对话窗内，打开方式统一.png》，聚焦优化对话窗内文件预览卡片的展示、聚合和打开方式菜单。

### 1.2 目标

1. 统一当前所有对话窗预览卡片的默认态、悬停态、标题、副标题、图标和操作区样式。
2. PRD 中列举的 11 类文件作为重点验收样例：HTML、MD、PDF、DOCX、XLSX、CSV、PPTX、PNG、GIF、JPG、JPEG。
3. HTML 网站卡片使用“网站名称”作为主标题，打开行为沿用当前内置浏览器链路。
4. 文件多于 3 个时默认折叠，只展示 3 个卡片和“显示另外 N 个”的展开入口。
5. 非 HTML 文件的“打开方式”下拉菜单内容保持与当前实现一致：展示系统默认应用、系统可打开应用和打开所在文件夹。
6. HTML 文件的打开方式菜单中，第一项固定展示内置浏览器入口；中文文案为“有道龙虾浏览器”，英文文案为“LobsterAI Browser”，后续系统应用只展示浏览器类应用；系统应用最多展示 5 个。
7. 对右边栏浏览器预览做信息展示优化：浏览器 tab 标题展示网站名称，地址栏展示文件地址并去掉左侧文件/网站 icon，地址栏聚焦时默认全选当前地址。
8. 不修改右侧 ArtifactPanel 的预览渲染、文件列表、分享、注释、设备工具栏等功能能力。
9. 卡片点击、打开方式和本地文件打开行为保持现有语义。
10. 新增 UI 文案必须进入 renderer i18n 的中英文资源。

### 1.3 非目标

1. 不修改右侧 ArtifactPanel 的预览渲染器、文件列表、分享、注释、设备工具栏或浏览器实际加载逻辑。
2. 不新增服务端分享能力，也不修改公共分享页。
3. 不新增或移除任何 Artifact 可预览类型；当前已经会展示成预览卡片的类型继续展示，只统一样式。
4. 不实现 Office 或图片文件内容缩略图。首版卡片仍是文件信息卡，不是内容预览缩略图。
5. 不新增 Artifact 可预览类型，也不改变右侧预览渲染能力；本次仅调整卡片展示去重、跨回复保留策略，以及点击旧卡片时映射到右侧面板 canonical artifact 的打开方式。

## 2. PRD 解读

### 2.1 卡片视觉

| 状态 | PRD 要求 | 设计结论 |
| --- | --- | --- |
| 默认态 | 背景调整为 `#FFFFFF` | 对话窗卡片使用白色底，不再使用灰色填充。深色模式沿用现有 surface token，但层级应接近输入框。 |
| 悬停态 | 背景调整为 `#FBFBFB` | hover 仅改变卡片填充色，不改变尺寸和布局。 |
| 图标 | icon 优先使用文件格式默认图标，也可使用“文件格式 + 颜色” | 使用现有 `FileTypeIcon` 作为默认文件图标来源，HTML 网站使用网站/地球图标。 |
| 标题 | HTML 为网站名称，普通文件为文件名 | HTML 特殊处理，其他类型用文件名。 |
| 副标题 | HTML 为“网站”，普通文件为“文件类型 · 扩展名” | 扩展名使用大写，文件名保留原大小写。 |
| 操作区 | 右侧展示“打开”或“打开方式” | 沿用当前交互语义；非 HTML 打开方式菜单只展示系统应用和打开所在文件夹；HTML 额外把内置浏览器入口放在第一项，中文显示“有道龙虾浏览器”、英文显示“LobsterAI Browser”，后续系统应用只展示浏览器类应用；系统应用最多展示 5 个。 |

### 2.2 多卡片展示

PRD 明确要求“当前最多展示 3 个，更多折叠起来，点击显示，展开全部”。因此每个 assistant turn 的卡片展示规则为：

1. 默认展示前 3 个可展示卡片。
2. 第 4 个及之后折叠到展开入口中。
3. 展开入口显示“显示另外 N 个”，点击后展示全部。
4. 展开状态只作用于当前 turn，不影响其他 turn。
5. 会话重新加载后默认回到折叠态。

### 2.3 HTML 网站卡片

HTML 是 PRD 中的特殊类型：

1. 主标题不是文件名，而是根据生成内容提炼的网站名称。
2. 副标题固定为“网站”。
3. 文件可能仍叫 `index.html`，但对话窗卡片不应展示 `index.html` 作为主标题。
4. 点击卡片时继续沿用当前内置浏览器打开链路。
5. 对话窗 HTML 卡片的“打开方式”菜单中，第一项展示内置浏览器入口（中文“有道龙虾浏览器”，英文“LobsterAI Browser”），然后才是系统浏览器应用和打开所在文件夹。
6. 右边栏浏览器预览同步做展示优化：tab 标题显示网站名称，地址栏显示文件地址且不展示左侧 icon；不改变浏览器预览加载逻辑。

### 2.4 优化覆盖范围

本次优化覆盖当前已经存在的对话窗预览卡片，不以 PRD 的 11 类文件作为过滤条件。也就是说，当前能被 `ArtifactPreviewCard` 展示的 HTML、SVG、图片、视频、Mermaid、代码、Markdown、文本、文档、本地服务等卡片，都需要套用同一套卡片视觉规范。

PRD 标题注明“文件卡片样式支持范围 共 11 个”，这些类型作为重点验收样例：

| 序号 | 文件类型 | 格式 | Artifact 类型 | 是否显示打开方式菜单 | 默认打开 |
| --- | --- | --- | --- | --- | --- |
| 1 | 网站 | HTML | `html` | 是 | 有道龙虾浏览器 |
| 2 | 文档 | MD | `markdown` | 沿用当前行为 | 右侧预览 |
| 3 | 文档 | PDF | `document` | 沿用当前行为 | 右侧预览 |
| 4 | 文档 | DOCX | `document` | 沿用当前行为 | 右侧预览 |
| 5 | 电子表格 | XLSX | `document` | 沿用当前行为 | 右侧预览 |
| 6 | 电子表格 | CSV | `document` 或 `text` | 沿用当前行为 | 右侧预览 |
| 7 | 幻灯片 | PPTX | `document` | 沿用当前行为 | 右侧预览 |
| 8 | 图像 | PNG | `image` | 沿用当前行为 | 右侧预览 |
| 9 | 图像 | GIF | `image` | 沿用当前行为 | 右侧预览 |
| 10 | 图像 | JPG | `image` | 沿用当前行为 | 右侧预览 |
| 11 | 图像 | JPEG | `image` | 沿用当前行为 | 右侧预览 |

PRD 图片中标注的其他类型可作为后续展示范围参考，但本次不新增支持能力，也不隐藏现有卡片：

| 类别 | 扩展名 |
| --- | --- |
| 普通文本 | `.txt`, `.rtf`, `.log` |
| 网页/前端 | `.css`, `.js`, `.ts`, `.jsx`, `.tsx`, `.vue`, `.mjs` |
| 图片/视觉 | `.webp`, `.svg`, `.bmp`, `.tiff`, `.ico` |
| 音视频/媒体 | `.mp4`, `.mp3`, `.wav`, `.webm`, `.mov`, `.srt` |
| 数据/配置 | `.json`, `.xml`, `.yaml`, `.yml`, `.env`, `.ini`, `.toml`, `.ndjson` |
| 代码文件 | `.py`, `.java`, `.cpp`, `.c`, `.cs`, `.go`, `.rs`, `.php`, `.rb`, `.sh`, `.ps1` |
| 压缩包/归档 | `.zip`, `.tar`, `.gz` |
| 数据库 | `.sqlite`, `.db` |
| 文档/排版 | `.tex`, `.epub`, `.odt`, `.ods`, `.odp` |

### 2.5 右边栏浏览器预览

新增 PRD 图片《codex-clipboard-2936e9dd-f37b-4003-8f04-2f2a64ea57d9.png》标注的是右边栏浏览器预览的信息展示优化，不是浏览器能力改造。对比外部浏览器打开效果后，设计结论为：

| 区域 | 当前问题 | 优化结论 |
| --- | --- | --- |
| 浏览器 tab 标题 | 右边栏浏览器 tab 固定显示“浏览器”或 HTML 文件名，不能反映当前页面内容 | 打开 HTML 文件预览时，tab 标题显示当前页面的 `document.title`，例如“愿大家天天都开心”；不使用文件名作为标题兜底，普通空白浏览器仍可显示“浏览器”。 |
| 地址栏 | 文件路径左侧展示了网站/文件 icon，占用空间且和外部浏览器地址栏不一致 | 地址栏左侧不展示 icon，只保留文件路径或 URL 文本。 |
| 本地文件地址 | 右边栏地址栏应与外部浏览器打开本地 HTML 的感知一致 | HTML 文件预览时地址栏展示本地文件地址或规范化后的文件路径，不展示内部 preview session URL。 |
| 外部浏览器打开 | 当前右侧工具栏里有独立外部浏览器打开按钮，和 PRD 中地址栏内右侧按钮不一致 | 取消独立右侧浏览器打开按钮；鼠标点击地址栏时默认选中当前地址，并在地址栏右侧显示与输入框边缘融合的外部浏览器打开按钮；地址栏失焦后按钮隐藏。 |

该优化不改变浏览器的后退、前进、刷新、截图、分享、注释、设备工具栏、清理 Cookie/缓存等功能。外部浏览器打开能力保留，但入口从独立工具栏按钮移动到地址栏右侧内嵌按钮；按钮默认隐藏，在地址栏聚焦或右侧操作热区 hover 时淡入，地址栏失焦、点击地址栏外或窗口失焦后隐藏，且不挤压地址文本。

## 3. 用户场景

### 场景 1: 生成 HTML 网站后展示网站卡片

**Given** AI 生成了 `/project/happy-wishes/index.html`，Artifact 类型为 `html`。
**When** 对话窗展示该 turn 的文件卡片。
**Then** 卡片主标题显示“愿大家天天都开心”这类网站名称，副标题显示“网站”，点击卡片在有道龙虾浏览器中打开。

### 场景 2: 同一轮生成多个文件

**Given** AI 一次生成了 `hello-world.md`、`hello-world.csv`、`hello-world.png`、`hello-world.pdf` 和 `hello-world.pptx`。
**When** 对话窗渲染该 assistant turn。
**Then** 默认只展示 3 个卡片，并显示“显示另外 2 个”；用户点击后展开全部 5 个。

### 场景 3: 打开 Office 文件

**Given** 用户看到 `hello-world.docx` 卡片。
**When** 用户点击“打开方式”。
**Then** 菜单内容与当前打开菜单一致，展示系统默认应用、系统可打开应用和“在文件夹中打开”，不额外插入内置浏览器预览项。

### 场景 4: 打开图片文件

**Given** 用户看到 `strange-tales-hero.jpg` 卡片。
**When** 用户点击卡片主体。
**Then** 按现有逻辑打开图片预览；点击“打开方式”可选择 Preview、Chrome、Safari 等系统可用应用和“在文件夹中打开”。

### 场景 5: 悬停反馈

**Given** 用户把鼠标悬停在任意支持卡片上。
**When** hover 状态生效。
**Then** 卡片背景变为 `#FBFBFB`，布局不抖动；普通文件副标题切换为“打开预览”，HTML/网站卡片副标题切换为“在有道龙虾浏览器中打开”。

### 场景 6: 右边栏浏览器预览 HTML 文件

**Given** 用户点击 HTML 预览卡片，在右边栏浏览器中打开 `/project/happy-wishes/index.html`。
**When** 右边栏浏览器 tab 和地址栏展示当前页面信息。
**Then** 浏览器 tab 标题显示当前页面标题“愿大家天天都开心”，不能显示 `index.html`、`pond-frog.html` 等文件名；地址栏显示本地 HTML 文件地址或规范化路径，地址栏左侧不展示 icon。

### 场景 7: 地址栏聚焦后外部打开

**Given** 用户正在右边栏浏览器预览 HTML 文件。
**When** 用户点击地址栏。
**Then** 地址栏默认全选当前地址，并显示地址栏右侧外部浏览器打开按钮；地址栏失焦后按钮隐藏，原右侧工具栏不再展示独立外部浏览器打开按钮。

### 场景 8: 多个回复引用同一个文件

**Given** 连续两个 assistant 回复都引用或更新了同一个本地预览文件。
**When** 对话窗分别渲染两个 assistant turn。
**Then** 两个回复后都展示该文件卡片；用户点击任一卡片时，都打开右侧面板当前保留的 canonical 预览，而不是回退到文件列表。

### 场景 9: HTML 打开方式菜单

**Given** 用户看到 `pond-frog.html` 这类 HTML 网站卡片。
**When** 用户点击“打开方式”。
**Then** 第一项展示“有道龙虾浏览器”或英文环境的 “LobsterAI Browser”；后续系统应用只展示浏览器类应用，最多 5 个，不展示 Code、Cursor、Sublime Text、TextEdit 等文本编辑器。

### 场景 10: Office/PDF 预览顶部按钮保持不变

**Given** 用户在右侧面板预览 PDF、DOCX、XLSX 或 PPTX。
**When** 查看顶部系统应用打开按钮。
**Then** 该按钮继续使用原有通用外部打开 icon 和原有行为；浏览器地址栏按钮的 icon 优化不影响 Office/PDF 预览。

## 4. 功能需求

### FR-1: 已有预览卡片样式全量覆盖

本次优化作用于当前所有已经展示在对话窗底部的 `ArtifactPreviewCard`，不新增类型过滤：

1. 当前会展示的 HTML、SVG、图片、视频、Mermaid、代码、Markdown、文本、文档、本地服务卡片都应用新样式。
2. PRD 的 11 类文件是重点验收对象，不作为展示白名单。
3. 不改变当前 Artifact 检测入口和右侧预览渲染能力；卡片展示只在同一消息内去重，跨 assistant 回复保留各自卡片。
4. Tool result 错误、临时日志输出和不可定位路径是否生成卡片，仍沿用现有规则。

卡片展示信息建议集中到一个策略模块，避免在组件中散落标题、副标题、图标和操作区规则。建议新增或扩展：

```text
src/renderer/components/artifacts/previewCardPolicy.ts
```

该模块输出：

```typescript
interface PreviewCardDescriptor {
  displayKind: PreviewCardDisplayKind;
  extensionLabel?: string;
  title: string;
  subtitle: string;
  hoverSubtitle: string;
  iconFileName: string;
  supportsOpenMenu: boolean;
  defaultOpenAction: PreviewCardOpenAction;
}
```

`PreviewCardDisplayKind` 和 `PreviewCardOpenAction` 必须使用 `as const` 常量对象定义，遵守仓库字符串常量规则。文件扩展名来自文件名，可作为展示值归一化处理，不需要为所有扩展名新增常量。

### FR-2: 标题和副标题规则

| 类型 | 主标题 | 副标题 | Hover 副标题 |
| --- | --- | --- | --- |
| HTML | 网站名称 | 网站 | 在有道龙虾浏览器中打开 / Open in LobsterAI Browser |
| MD | 文件名 | 文档 · MD | 打开预览 |
| PDF | 文件名 | 文档 · PDF | 打开预览 |
| DOCX | 文件名 | 文档 · DOCX | 打开预览 |
| XLSX | 文件名 | 电子表格 · XLSX | 打开预览 |
| CSV | 文件名 | 电子表格 · CSV | 打开预览 |
| PPTX | 文件名 | 幻灯片 · PPTX | 打开预览 |
| PNG | 文件名 | 图像 · PNG | 打开预览 |
| GIF | 文件名 | 图像 · GIF | 打开预览 |
| JPG | 文件名 | 图像 · JPG | 打开预览 |
| JPEG | 文件名 | 图像 · JPEG | 打开预览 |
| SVG | 文件名 | 图像 · SVG | 打开预览 |
| WebP/其他现有图片 | 文件名 | 图像 · 扩展名 | 打开预览 |
| Video | 文件名 | 视频 · 扩展名 | 打开预览 |
| Mermaid | 文件名或标题 | 图表 | 打开预览 |
| Code | 文件名 | 代码 · 扩展名 | 打开预览 |
| Text/Log | 文件名 | 文本 · 扩展名 | 打开预览 |
| Local service | 服务名或 URL | 网站 | 在有道龙虾浏览器中打开 / Open in LobsterAI Browser |

HTML 网站名称来源优先级：

1. `artifact.title` 中非文件名的标题。
2. 已有 Artifact 字段中可用的网站标题信息，若后续链路已经补充。
3. HTML `<title>` 或首个主要标题，若能在卡片展示层低成本读取且不影响右侧预览。
4. 文件名兜底，例如 `index.html`。

首版如无法稳定解析 HTML 内容标题，可先使用 `artifact.title`，但不能把文件路径作为主标题。

### FR-3: 卡片视觉结构

单个卡片包含：

1. 左侧文件图标，固定尺寸，使用文件类型颜色。
2. 中间标题和副标题，两行文本，超长截断。
3. 右侧操作区，展示“打开”或“打开方式”。
4. 卡片行宽度与会话内容区宽度一致，不再使用短卡片横向换行。
5. 多个卡片合并到同一个文件卡片组内，卡片组负责外层边框、圆角和背景，单个卡片行之间使用分割线。

浅色模式视觉：

| Token | 值 |
| --- | --- |
| 默认背景 | `#FFFFFF` |
| Hover 背景 | `#FBFBFB` |
| 边框 | 沿用 `border-border` |
| 标题 | 沿用 `text-foreground` |
| 副标题 | 沿用 `text-secondary` |

暗色模式不直接套用浅色 hex，卡片组默认背景应接近页面背景但略高一层；hover 只使用低透明度白色叠加轻微提亮，避免跳到高亮 surface 造成强烈反差。

### FR-4: 文件图标

1. 普通文件使用 `FileTypeIcon`，避免继续维护 `ArtifactPreviewCard` 内的多套手写 SVG。
2. 图标颜色由扩展名决定，例如 PDF 红、Word 蓝、Excel 绿、PPT 橙、图片灰或蓝。
3. HTML 网站使用网站图标，不使用通用代码图标。
4. 图标仅作为视觉辅助，不能替代标题和副标题。

### FR-5: 多卡片折叠

在 `AssistantTurnBlock` 中对当前 turn 的 artifacts 做展示切片：

1. `visibleCards = cards.slice(0, 3)`。
2. `hiddenCount = cards.length - visibleCards.length`。
3. `hiddenCount > 0` 时展示展开入口。
4. 展开后展示全部卡片，并可显示“收起”入口。
5. 折叠/展开状态按 turn ID 存储在组件本地 state 即可。
6. 折叠逻辑不影响右侧 ArtifactPanel 的文件列表，面板仍展示所有 artifacts。
7. 展开/收起入口固定显示在卡片组底部居中，不与文件卡片同行展示。

排序建议：

1. 保留 artifact 产生顺序作为主顺序。
2. HTML 网站优先展示在首位。
3. 展示粒度按 assistant turn 计算：同一回复内同一路径只展示一张卡片；不同回复即使指向同一个文件，也分别在各自回复后展示卡片。
4. 右侧 ArtifactPanel 的文件列表和 tab 去重继续沿用当前策略，不因对话流重复展示卡片而新增功能性变化。
5. 当多个回复中的卡片指向同一个预览文件时，点击任一卡片都需要解析到右侧 ArtifactPanel 当前保留的 canonical artifact，避免旧卡片 id 被会话级去重后找不到而回退到文件列表。

### FR-6: 打开方式菜单

“打开方式”下拉菜单不因为本次优化新增右侧预览、分享或其他功能项。非 HTML 文件保持当前系统应用内容；HTML 文件只展示浏览器类系统应用。参考 Codex 预览卡片逻辑，系统应用最多展示 5 个；“在文件夹中打开”等固定功能项不计入 5 个系统应用名额。菜单排序：

1. HTML 文件：第一项固定展示内置浏览器入口，中文为“有道龙虾浏览器”，英文为“LobsterAI Browser”。
2. HTML 文件：系统默认浏览器。
3. HTML 文件：系统返回的其他浏览器应用。
4. 非 HTML 文件：系统默认应用、系统返回的已安装推荐应用和其他系统可打开应用，沿用当前菜单。
5. 固定底部操作：“在文件夹中打开”。

菜单项规则：

| 菜单项 | 行为 |
| --- | --- |
| 有道龙虾浏览器 / LobsterAI Browser | 打开 HTML 文件对应的内置浏览器标签 |
| 系统默认应用 | 调用 `shell.openPath` |
| 指定应用 | 调用 `shell.openPathWithApp` |
| 在文件夹中打开 | 调用 reveal local path |

如果 `getAppsForFile` 失败，菜单仍显示“在文件夹中打开”；HTML 文件仍应保留内置打开入口。失败不应阻断卡片主体点击预览。

### FR-7: 默认点击行为

| 类型 | 点击卡片主体 |
| --- | --- |
| HTML | 在有道龙虾浏览器中打开 |
| MD | 打开右侧 Markdown 预览 |
| PDF | 打开右侧 PDF 预览 |
| DOCX | 打开右侧文档预览 |
| XLSX | 打开右侧表格预览 |
| CSV | 打开右侧表格或文本预览 |
| PPTX | 打开右侧幻灯片预览 |
| PNG/GIF/JPG/JPEG | 打开右侧图片预览 |

“打开方式”按钮点击只打开菜单，不触发卡片主体默认行为。

### FR-8: 保持现有打开联动

1. 卡片主体点击行为沿用当前实现，不新增右侧预览功能。
2. 非 HTML 文件继续按当前逻辑打开对应 Artifact 预览。
3. HTML 卡片继续走当前 `onOpenHtmlFile`，进入内置浏览器标签。
4. local-service 仍按现有逻辑打开浏览器标签，也应用新卡片样式。
5. 同一 artifact 重复点击不新增重复 tab，沿用当前 tab 去重逻辑。
6. 非 HTML 重复文件卡片在打开预览 tab 前，按右侧面板的会话级去重规则解析为 canonical artifact id；同一路径的旧回复卡片和新回复卡片都应打开同一个右侧预览，而不是显示文件列表。

### FR-9: 右边栏浏览器预览信息优化

右边栏浏览器预览仅优化信息展示，不改变浏览器加载、预览 session、注释、分享和工具栏能力。

1. 当通过 HTML 预览卡片打开右边栏浏览器时，浏览器 tab 标题优先显示当前页面的 `document.title`。
2. 浏览器 tab 标题不复用预览卡片标题规则，也不使用 HTML 文件名兜底；如果 `document.title` 为空，或 Electron/webview 返回值等于当前 URL/地址栏的 basename，则回退显示“浏览器”。
3. 地址栏展示用户可理解的地址：HTML 文件预览优先展示本地文件路径或 `file://` 地址，不展示内部 preview session 的 `127.0.0.1` URL。
4. 地址栏左侧不展示文件/网站 icon，只保留输入框文本和既有操作按钮。
5. 取消右侧工具栏中的独立外部浏览器打开按钮。
6. 用户点击或聚焦地址栏时，默认选中当前地址，便于复制或直接输入新地址。
7. 地址栏聚焦或右侧操作热区 hover 时显示外部浏览器打开按钮，按钮行为沿用当前外部打开逻辑。
8. 外部浏览器打开按钮使用地址栏右侧内嵌样式，右边缘和地址栏圆角融合，左侧使用细分割线，淡入淡出，不改变地址输入框文本布局。
9. 地址栏失焦后隐藏外部浏览器打开按钮。
10. 浏览器 tab 关闭按钮、添加 tab、展开面板、刷新、后退、前进、截图、注释等功能保持现有行为。
11. 空白浏览器 tab、手动输入 URL、本地服务 URL 也可使用当前页面 `document.title`；没有页面标题时回退显示“浏览器”。
12. 如果页面标题无法解析，tab 标题回退到“浏览器”，不能显示空白，也不能回退为文件名。

### FR-10: i18n

新增或调整文案必须写入 `src/renderer/services/i18n.ts` 的 `zh` 和 `en`：

| key 建议 | 中文 | 英文 |
| --- | --- | --- |
| `artifactPreviewCardShowMore` | 显示另外 {count} 个 | Show {count} more |
| `artifactPreviewCardShowLess` | 收起 | Show less |
| `artifactPreviewCardOpenPreview` | 打开预览 | Open preview |
| `artifactPreviewCardOpenWith` | 打开方式 | Open with |
| `artifactPreviewCardLobsterBrowser` | 有道龙虾浏览器 | LobsterAI Browser |
| `artifactPreviewCardOpenInLobsterBrowser` | 在有道龙虾浏览器中打开 | Open in LobsterAI Browser |
| `artifactFileKindWebsite` | 网站 | Website |
| `artifactFileKindDocument` | 文档 | Document |
| `artifactFileKindSpreadsheet` | 电子表格 | Spreadsheet |
| `artifactFileKindPresentation` | 幻灯片 | Presentation |
| `artifactFileKindImage` | 图像 | Image |
| `artifactFileKindVideo` | 视频 | Video |
| `artifactFileKindDiagram` | 图表 | Diagram |
| `artifactFileKindCode` | 代码 | Code |
| `artifactFileKindText` | 文本 | Text |
| `artifactFileKindFile` | 文件 | File |

## 5. 实现方案

### 5.1 展示策略模块

新增 `previewCardPolicy.ts`，集中处理：

1. 根据 Artifact 类型、文件名、路径和扩展名生成卡片展示描述，不做展示白名单过滤。
2. 生成标题、副标题、hover 副标题、图标文件名和默认打开动作。
3. 对 PRD 11 类文件提供精确标题、副标题和图标规则。
4. 对其他现有 Artifact 类型提供通用 fallback 规则。
5. 定义菜单项类型和排序权重。

建议常量：

```typescript
export const PreviewCardDisplayKind = {
  Website: 'website',
  Document: 'document',
  Spreadsheet: 'spreadsheet',
  Presentation: 'presentation',
  Image: 'image',
  Video: 'video',
  Diagram: 'diagram',
  Code: 'code',
  Text: 'text',
  File: 'file',
} as const;
```

消费者使用 `PreviewCardDisplayKind.Website`，不直接比较 `'website'`。

### 5.2 ArtifactPreviewCard 改造

`src/renderer/components/artifacts/ArtifactPreviewCard.tsx` 改造方向：

1. 删除或减少组件内部手写类型 SVG，使用 `FileTypeIcon`。
2. 接收 `PreviewCardDescriptor` 或在组件内部通过策略模块生成 descriptor。
3. 使用 descriptor 的 `subtitle` 和 `hoverSubtitle` 切换悬停文案；普通文件 hover 显示“打开预览”，HTML/网站 hover 显示“在有道龙虾浏览器中打开”。
4. 将卡片主体和操作按钮拆开，避免按钮嵌套和点击冒泡问题。
5. 非 HTML “打开方式”菜单沿用当前系统应用和打开所在文件夹内容。
6. HTML 文件在系统应用列表第一项插入内置浏览器入口，中文显示“有道龙虾浏览器”、英文显示“LobsterAI Browser”，后续只展示浏览器类应用，系统浏览器最多展示 5 个。
7. `supportsOpenMenu` 依赖本地 `filePath`；没有本地路径的内容型 artifact 仍可点击默认预览，但不展示系统应用打开项。
8. 菜单定位沿用 portal，但需要支持卡片在页面底部时向上展开。
9. 加入键盘可访问性：Enter 打开默认预览，Escape 关闭菜单。

### 5.3 AssistantTurnBlock 折叠

`src/renderer/components/cowork/AssistantTurnBlock.tsx` 改造方向：

1. 在渲染卡片前使用策略模块为所有现有 preview cards 生成展示 descriptor。
2. 与 `VideoArtifactPathList` 的展示职责分离，避免视频路径列表被算入 3 个卡片。
3. 默认展示 3 个，超出部分折叠。
4. 展开入口放在卡片列表末尾，样式轻量，不做大卡片。
5. 展开状态按 `turn.id` 或当前 block 实例保存。
6. 卡片数据从当前 turn 关联的 artifacts 获取，不从会话级去重列表获取；当前 turn 内再按路径去重，避免同一回复重复卡片。
7. 如果连续两个模型回复都更新或引用同一个预览文件，应展示两张卡片，分别位于对应回复之后。
8. 卡片点击打开预览时仍需要和右侧面板的会话级去重结果对齐：如果当前卡片 artifact 已被去重淘汰，则打开同文件 canonical artifact 的预览 tab。
9. `CoworkSessionDetail` 传给 `AssistantTurnBlock` 的 `turnArtifacts` 使用当前会话原始 artifact 列表按 turn 过滤，避免提前使用会话级展示去重结果导致旧回复卡片消失。

### 5.4 HTML 网站名称

首版实现优先使用现有 artifact 字段，不新增主进程 HTML 解析：

1. 如果 `artifact.title` 不是文件名且不是空，作为网站名称。
2. 如果 `artifact.title` 是 `index.html` 或其他文件名，尝试从 `artifact.fileName` 之外的消息上下文获取标题，此步骤可后续补充。
3. 兜底使用文件名，避免空标题。

后续增强如需在 HTML preview session 创建前解析 `<title>` 并写入 Artifact metadata，需要单独评估，不纳入本次卡片样式优化。

### 5.5 打开方式数据

当前 `OpenDropdown` 已通过 `window.electron.shell.getAppsForFile()` 获取系统应用列表。本次只做展示顺序和 HTML 特例归一化；系统应用筛选和数量限制在 `src/main/shellApps.ts` 中统一处理：

1. 读取系统应用列表。
2. 去重相同 app path。
3. 非 HTML 文件标记默认应用，保持当前系统应用展示内容。
4. HTML 文件在列表第一项插入内置浏览器入口，中文显示“有道龙虾浏览器”、英文显示“LobsterAI Browser”。
5. HTML 文件对系统应用结果做浏览器过滤，只保留 Chrome、Safari、Firefox、Edge、Arc、Brave、Chromium 等浏览器类应用，不展示 Code、Cursor、Sublime Text、TextEdit 等文本编辑器。
6. 非 HTML 文件不插入内置浏览器预览或其他新增功能项，系统应用最多展示 5 个，仍保留原有文档、Office、图片等文件的系统应用排序和过滤策略。
7. 固定追加“在文件夹中打开”。

如果系统应用列表中包含浏览器，HTML 的菜单仍必须把内置打开入口放在第一项。

### 5.6 右边栏浏览器预览优化

右边栏浏览器预览涉及 `CoworkSessionDetail` 的浏览器状态传递和 `ArtifactPanel` 内的 `BrowserTabContent` 展示。

实现方向：

1. 在 `CoworkSessionDetail` 中维护 `browserPreviewTitle`，按 session 保存当前浏览器页面标题。
2. `BrowserTabContent` 在 `dom-ready`、`did-stop-loading`、`page-title-updated` 等时机读取 `document.title` 并回传；顶部浏览器 tab 的 label 使用该页面标题，否则继续使用 `artifactBrowserTab`。
3. 如果 webview/Electron 返回的标题等于当前 URL 或地址栏路径的 basename，例如 `pond-frog.html`，应视为无页面标题并回退到“浏览器”。
4. 地址栏输入框展示 `browserAddress`，HTML 文件预览时该值应为 artifact 的本地 filePath 或规范化后的 `file://` 地址，而不是 preview session 返回的内部 URL。
5. `BrowserTabContent` 的地址栏左侧 icon 移除；保留后退、前进、刷新、截图、注释和菜单按钮。
6. 移除右侧工具栏常驻的外部浏览器打开按钮。
7. 地址栏输入框增加聚焦态：点击或 focus 时调用 select，使当前地址默认全选。
8. 地址栏聚焦或右侧操作热区 hover 时在输入框右侧展示外部浏览器打开按钮；按钮使用当前可打开地址，行为沿用现有 `handleOpenExternal`。
9. 外部浏览器打开按钮应位于地址栏内部右侧，以绝对定位淡入显示，不挤压地址文本；按钮右侧与地址栏右边缘和圆角融合，左侧使用轻微分割线形成内嵌操作区；仅该地址栏按钮 icon 使用轻量右上箭头，不再使用“窗口边框 + 箭头”的重图标，也不再作为工具栏独立按钮常驻。Office/PDF 等预览顶部的系统应用打开按钮保持原有通用外部打开 icon。
10. 地址栏点击或 focus 触发地址文本全选并显示外部浏览器打开按钮；地址栏失焦、点击地址栏外或窗口失焦后隐藏该按钮。
11. 如果需要对 HTML 文件使用本地文件地址而非内部 URL，应沿用现有 `onOpenHtmlFileInBrowser` 和 preview session 的安全边界，不直接绕过当前打开链路。
12. 如果当前浏览器 tab 手动导航到其他 URL，后续 tab 标题应跟随新页面的 `document.title` 更新。
13. 不新增右侧浏览器预览功能项，不改变 iframe/webview 加载、注释捕获、截图、分享、设备尺寸和 zoom 逻辑。

### 5.7 Artifact 去重与预览 tab 映射

为同时满足“每个回复后展示自己的预览卡片”和“右侧面板继续复用当前 canonical 预览”的要求，去重策略拆成两层：

1. `dedupeArtifactsWithinMessages()` 只在同一 `messageId` 内按 file path、remote URL 或 local-service URL 去重；不同 assistant 回复中的同一路径 artifact 不互相覆盖。
2. `setSessionArtifacts` 和 `addArtifact` 使用同一消息内去重，保证对话流可以保留跨回复重复卡片。
3. `dedupeArtifactsForDisplay()` 继续作为右侧面板文件列表和预览 tab 的会话级展示去重策略；同一路径只保留更适合展示的 artifact。
4. `resolveArtifactIdForDisplay()` 在打开预览 tab 前把旧卡片 artifact id 解析到当前 display artifact id，避免用户点击旧回复卡片时因 artifact 已被会话级去重而显示文件列表。
5. `artifactSlice.test.ts` 覆盖两个关键行为：不同消息的同一路径卡片被保留；点击旧卡片会打开 canonical artifact 的预览 tab。

## 6. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| Artifact 没有文件名 | 从 filePath 解析 basename，仍失败则使用 artifact.title |
| HTML 卡片标题解析不到 | 卡片可使用 artifact.title 或文件名兜底，避免对话窗卡片空标题 |
| 右侧浏览器页面标题解析不到 | 浏览器 tab 回退到“浏览器”，不能使用 HTML 文件名兜底 |
| 文件扩展名大写 | 归一化为小写判断，展示副标题时转大写 |
| CSV 被识别为 `text` | 只要扩展名是 `.csv`，仍使用电子表格卡片规则 |
| 图片只有 data URL 没有 filePath | 沿用当前卡片点击打开预览；没有本地文件路径时不展示系统应用打开项 |
| `getAppsForFile` 返回空 | 显示“在文件夹中打开”；HTML 文件仍显示“有道龙虾浏览器”/“LobsterAI Browser” |
| 文件已经删除 | 卡片主体打开预览时展示现有错误态，菜单中系统打开项禁用或失败 toast |
| 文件很多 | 默认折叠，展开后允许换行，不影响消息正文阅读 |
| 连续回复更新同一文件 | 每个回复后都展示该文件卡片；同一回复内重复路径只保留一张；点击任一卡片都打开右侧面板保留的 canonical 预览 |
| HTML 系统应用返回文本编辑器 | `shellApps.ts` 对 `.html`/`.htm` 只保留浏览器类应用，过滤 Code、Cursor、Sublime Text、TextEdit 等编辑器 |
| Local service 卡片 hover | 视为网站类卡片，hover 副标题显示“在有道龙虾浏览器中打开”/“Open in LobsterAI Browser” |
| 地址栏按钮显示后焦点离开 | 点击地址栏外、焦点移出地址栏或窗口失焦时隐藏外部浏览器打开按钮 |
| Office/PDF 顶部系统应用打开按钮 | 保持原有通用外部打开 icon 和系统应用打开行为，不复用浏览器地址栏专用 icon |
| 窄屏或小窗口 | 卡片宽度跟随容器，标题截断，操作区不挤压标题到不可读 |
| 深色模式 | 卡片组使用独立 dark surface，hover 使用低透明度白色叠加，避免与浅色 hover 形成过强反差 |

## 7. 涉及文件

| 文件 | 变更 |
| --- | --- |
| `src/main/shellApps.ts` | HTML/HTM 系统应用过滤为浏览器类应用，系统应用最多返回 5 个 |
| `src/renderer/components/artifacts/ArtifactPreviewCard.tsx` | 卡片视觉、图标、hover 副标题、打开方式菜单、默认点击行为 |
| `src/renderer/components/artifacts/previewCardPolicy.ts` | 新增展示策略、标题副标题和打开动作描述 |
| `src/renderer/components/artifacts/ArtifactPanel.tsx` | 浏览器 tab label、页面标题读取、地址栏 icon 移除、地址栏聚焦全选、外部打开入口移动到地址栏右侧内嵌按钮；Office/PDF 顶部通用打开按钮保持原 icon |
| `src/renderer/components/cowork/AssistantTurnBlock.tsx` | 多卡片折叠、展开入口、卡片展示 descriptor 生成 |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | HTML 浏览器预览上下文、右边栏浏览器 tab 标题和地址传递、按原始 artifact 列表为每个 turn 提供卡片 |
| `src/renderer/services/artifactParser.ts` | 增加同消息内去重、会话级 canonical artifact id 解析 |
| `src/renderer/services/i18n.ts` | 新增中英文文案 |
| `src/renderer/store/slices/artifactSlice.ts` | session artifact 存储改为同消息内去重，打开预览 tab 前解析 canonical artifact |
| `src/renderer/store/slices/artifactSlice.test.ts` | 覆盖跨回复同文件卡片保留和旧卡片打开 canonical 预览 |
| `src/renderer/index.css` | 增加预览卡片组、卡片行、深色 hover 的专用样式 |

## 8. 验收标准

1. 当前所有已有对话窗预览卡片均套用统一样式；HTML、MD、PDF、DOCX、XLSX、CSV、PPTX、PNG、GIF、JPG、JPEG 作为重点验收样例。
2. HTML 卡片主标题展示网站名称，副标题展示“网站”，点击默认进入有道龙虾浏览器。
3. 普通文件卡片主标题展示文件名，副标题展示“类型 · 扩展名”，扩展名为大写。
4. 浅色模式默认态卡片背景为白色，hover 背景为 `#FBFBFB`；深色模式 hover 只轻微提亮，无布局抖动。
5. 文件图标能按扩展名区分颜色和样式，不再全部使用通用 icon。
6. 同一 turn 超过 3 个卡片时默认折叠，展开入口文案显示正确数量，点击后展示全部。
7. 非 HTML 文件的“打开方式”菜单内容与当前菜单一致，只展示系统应用和打开所在文件夹。
8. HTML 文件的“打开方式”菜单第一项中文展示“有道龙虾浏览器”、英文展示“LobsterAI Browser”，后续只展示浏览器类系统应用并可正常打开，浏览器类系统应用最多 5 个。
9. HTML 文件的系统应用列表不展示 Code、Cursor、Sublime Text、TextEdit 等文本编辑器。
10. 普通文件卡片 hover 时副标题显示“打开预览”；HTML/网站卡片 hover 时副标题显示“在有道龙虾浏览器中打开”。
11. 没有 filePath 的内容型 artifact 仍可按当前卡片主体行为打开预览，系统应用项不出现或不可用。
12. 右侧 ArtifactPanel 的预览渲染、文件列表、分享、注释和工具栏功能不发生变化。
13. 连续两个模型回复都引用或更新同一个预览文件时，两个回复后都展示该文件卡片。
14. 同一个模型回复内同一路径重复出现时，只展示一张卡片。
15. 点击跨回复重复文件的任一卡片，都打开右侧面板 canonical artifact 的预览 tab，不显示文件列表。
16. 深色模式下卡片、hover 和菜单有清晰层级，文字可读，hover 不出现大面积高亮反差。
17. 所有新增用户可见文案均有中英文 i18n key。
18. 运行 `npm run lint` 不产生新增 lint 错误。
19. HTML 文件在右边栏浏览器预览时，浏览器 tab 标题展示当前页面 `document.title`，不能显示 HTML 文件名。
20. HTML 文件在右边栏浏览器预览时，地址栏显示本地文件地址或规范化文件路径，不显示内部 preview session URL。
21. 右边栏浏览器地址栏左侧不展示文件/网站 icon，文本区域可用宽度增加。
22. 右边栏浏览器不再展示独立的外部浏览器打开工具栏按钮。
23. 用户点击或聚焦地址栏时，当前地址默认被选中。
24. 地址栏点击或聚焦后显示外部浏览器打开按钮；失焦、点击地址栏外或窗口失焦后隐藏按钮。
25. 地址栏外部浏览器打开按钮与地址栏右侧融合显示，左侧只有细分割线，不挤压地址文本，并可正常用系统默认浏览器打开当前地址。
26. 只有浏览器地址栏按钮使用轻量右上箭头 icon；Office/PDF 等预览顶部的系统应用打开按钮保持原有通用 icon 和行为。

## 9. 待确认

1. “任务完成后自动打开预览”在 PRD 中被标注为问题，首版建议不自动打开，只保留用户点击卡片打开，避免打断对话阅读。
2. HTML 网站名称是否需要由 agent 明确写入 metadata，还是由前端解析 `<title>`，需要结合 OpenClaw 输出结构再定。
3. 非 PRD 11 类但现有已经展示的卡片，只做样式统一；后续是否补充更精细的类型名称和图标，需要新的 PRD 明确。
