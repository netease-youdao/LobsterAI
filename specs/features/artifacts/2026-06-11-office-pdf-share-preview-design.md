# Office/PDF 文件分享预览设计文档

## 1. 概述

### 1.1 问题/背景

当前 LobsterAI 已支持 HTML Artifact 分享，并在近期扩展了图片和 SVG 分享。分享链路由 `lobsterai-server` 提供：

- 客户端把待分享内容打成 zip，通过 `/api/html-shares` 上传。
- 服务端保存 `html_shares` / `html_share_files`，把文件上传到 NOS。
- 公共页面通过 `/s/{shareId}/` 访问，支持分享码、状态管理、内容审核、访问统计和管理员预览。
- 公共内容通过 `/s/{shareId}/content/` 由服务端同源代理返回，不暴露 NOS URL。

客户端已经具备 Office/PDF 本地预览能力，主要在 `src/renderer/components/artifacts/renderers/DocumentRenderer.tsx`：

| 文件类型 | 当前客户端渲染方式 |
| --- | --- |
| `.docx` | `docx-preview` 渲染分页文档 |
| `.pdf` | `pdfjs-dist` 渲染 canvas 页面 |
| `.pptx` | `pptx-preview` 渲染幻灯片，包含 PPTX 资源修复逻辑 |
| `.xlsx` / `.xls` / `.csv` / `.tsv` | `xlsx` 解析并渲染表格 |

新增需求是让分享功能支持 Office 文件和 PDF，并在分享页预览文件内容。Web 端预览存在性能上限，因此文件过大时必须在公共页面直接展示下载链接，不应先下载文件再放弃渲染。文件大小阈值需要由服务端配置。

### 1.2 目标

1. Artifact 面板选中文档文件时支持分享 Word、PPT、Excel 和 PDF。
2. 分享公共页复用现有 `/s/{shareId}/`、分享码、管理员预览、审核和访问统计能力。
3. 分享页使用与龙虾客户端一致的主渲染库和近似交互体验。
4. 服务端在 shell 阶段根据文件类型、文件大小和配置判断是否允许 Web 预览。
5. 文件超过 Web 预览阈值时，公共页不加载预览 bundle、不请求原文件预览内容，只展示下载入口。
6. 上传大小限制和 Web 预览大小限制分离：允许分享的大文件可以只下载不预览。
7. 文档分享默认使用分享码访问；如后续开放公开访问，必须复用现有访问模式配置和审核治理。
8. 文档内容进入模型内容审查，覆盖标题、可提取文本、嵌入图片和扫描/截图型内容的兜底处理。
9. 现有 HTML、图片、SVG 分享行为不变。

### 1.3 非目标

1. 首期不做服务端 Office 转图片或 PDF 转码。
2. 首期不依赖 Microsoft Office Online、Google Docs Viewer 或公网 CDN。
3. 首期不支持 `.doc`、`.ppt`、`.docm`、`.xlsm`、`.pptm` 等旧格式或宏格式。
4. 首期不做完整 OCR。扫描版 PDF 或图片型 PPT 需要通过视觉抽样审核或进入人工复核，不能因为文本提取为空而直接通过。
5. 不向 Electron、Admin、公共页面或访问者暴露 NOS URL。

## 2. 用户场景

### 场景 1: 分享可预览的 DOCX

**Given** 用户在 Artifact 面板选中一个 8 MB 的 `.docx` 文件，用户已登录且订阅有效。  
**When** 用户点击分享并创建分享。  
**Then** 客户端上传 `document_file` 分享，服务端返回分享链接和分享码，访问者输入分享码后在 `/s/{shareId}/` 看到分页文档预览和下载按钮。

### 场景 2: 分享超过 Web 预览阈值的 PPTX

**Given** 服务端配置 `html-share.document.preview.max-render-bytes=26214400`，用户分享一个 80 MB 的 `.pptx` 文件。  
**When** 访问者打开分享页并通过分享码。  
**Then** 分享页不加载 PPTX 预览脚本，不请求 `/content/?preview=1`，只展示文件名、大小、不可预览原因和下载按钮。

### 场景 3: 管理员审核预览文档分享

**Given** 管理员在分享管理后台打开一个 `document_file` 分享。  
**When** 管理员点击预览。  
**Then** 后台调用现有 preview token 接口并打开服务端返回的 `previewUrl`，公共页使用管理员 preview cookie 放行，不泄露分享码。

### 场景 4: 文档内容更新后复用原分享链接

**Given** 同一个本地 `.xlsx` 文件已经分享过。  
**When** 用户修改本地文件后再次点击分享更新。  
**Then** 客户端通过 `clientSourceKey` 找到已有分享，调用更新接口，服务端保留原 `shareId` 和 URL，同时更新 `sourceSha256`、文件内容和审核状态。

### 场景 5: 不支持的文档格式

**Given** 用户尝试分享 `.docm` 文件。  
**When** 客户端或服务端校验文件类型。  
**Then** 分享被拒绝，客户端展示“不支持该文件类型”的用户可见提示。

### 场景 6: 扫描版 PDF 触发复核

**Given** 用户分享一个扫描版 PDF，文本提取结果为空。  
**When** 服务端异步内容审查执行。  
**Then** 服务端至少对抽样页面生成图片并提交视觉审核；如果无法完成视觉审核，则将分享标记为 `review` 或 `error`，等待管理员处理，不直接标记为 `passed`。

## 3. 功能需求

### FR-1: 新增文档分享来源类型

新增 `sourceType=document_file`。采用单一来源类型，不按 Word/PPT/Excel/PDF 拆分。具体文件类型由 `entryFile` 后缀和 `html_share_files.content_type` 判断。

首期支持范围：

| 扩展名 | 上传 | Web 预览 | MIME |
| --- | --- | --- | --- |
| `.docx` | 是 | 是 | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `.pptx` | 是 | 是 | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| `.xlsx` | 是 | 是 | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `.pdf` | 是 | 是 | `application/pdf` |
| `.csv` | 是 | 是 | `text/csv;charset=UTF-8` |
| `.tsv` | 是 | 是 | `text/tab-separated-values;charset=UTF-8` |
| `.xls` | 可选 | 可选 | `application/vnd.ms-excel` |

### FR-2: 文档分享创建与更新

复用现有接口：

```text
POST /api/html-shares
PUT /api/html-shares/{shareId}
GET /api/html-shares/source?sourceType=document_file&clientSourceKey=<key>&includeDisabled=true
```

文档分享请求规则：

- `archive` 是单文件 zip。
- zip 中唯一文件路径必须等于规范化后的 `entryFile`。
- `sourceSha256` 使用原始文档 bytes 的 SHA-256，不使用外层 zip hash。
- 服务端按扩展名、MIME 和 magic bytes 做权威校验。
- 更新分享不允许改变 `sourceType`，也不允许通过更新隐式重新打开 disabled 分享。
- 响应中的最终分享 URL 只能是 `/s/{shareId}/` 公共页，不能返回 `/content/`、NOS URL 或原始远端 URL。
- 文档分享首期默认 `accessMode=code`。如果 UI 保留公开访问选项，服务端仍必须支持访问模式校验、主动关闭、审核拒绝后不可由用户重新打开等现有规则。

### FR-3: 可配置大小策略

服务端新增配置：

```properties
html-share.document.max-archive-bytes=104857600
html-share.document.max-file-bytes=104857600
html-share.document.preview.max-render-bytes=26214400
html-share.document.preview.max-pdf-pages=300
html-share.document.preview.max-sheet-cells=200000
html-share.document.preview.enabled=true
```

含义：

| 配置 | 默认建议 | 用途 |
| --- | --- | --- |
| `max-archive-bytes` | 100 MiB | 外层分享 zip 最大大小 |
| `max-file-bytes` | 100 MiB | 原始文档最大上传大小 |
| `preview.max-render-bytes` | 25 MiB | Web 端最大预览文件大小 |
| `preview.max-pdf-pages` | 300 | PDF 页数超过后停止渲染并提示下载 |
| `preview.max-sheet-cells` | 200000 | 表格单元格超过后停止渲染并提示下载 |
| `preview.enabled` | true | 文档 Web 预览总开关 |

### FR-4: 公共页预览与下载

文档分享公共入口仍为：

```text
GET /s/{shareId}/
```

服务端 shell 阶段计算：

```text
preview.available =
  document.preview.enabled
  && extension is preview-supported
  && entry file size <= document.preview.max-render-bytes
```

不可预览原因：

| reason | 说明 |
| --- | --- |
| `disabled_by_config` | 服务端关闭文档 Web 预览 |
| `unsupported_type` | 文件类型不支持 Web 预览 |
| `too_large` | 文件大小超过 Web 预览阈值 |

新增下载语义：

```text
GET /s/{shareId}/content/?download=1
```

下载响应必须：

- 继续校验分享状态、分享码 cookie 和管理员 preview cookie。
- 通过服务端同源代理返回文件，不重定向到 NOS。
- 设置 `Content-Disposition: attachment`，文件名必须清洗并提供 UTF-8 `filename*`。
- 设置 `Vary: Cookie, Sec-Fetch-Site`，并对跨站子资源请求返回 403。
- 设置 `Cross-Origin-Resource-Policy: same-origin`、`X-Content-Type-Options: nosniff` 和私有缓存策略。

### FR-5: 分享页渲染库与体验

文档预览静态资源由服务端同源托管，不使用外部 CDN。建议位置：

```text
lobsterai-server/src/main/resources/static/html-share/office-preview/
```

建议独立 mini bundle：

```text
office-preview.js
office-preview.css
pdf.worker.mjs
vendor-docx-preview.js
vendor-pptx-preview.js
vendor-pdfjs.js
vendor-xlsx.js
```

渲染行为：

| 类型 | Web 分享页行为 |
| --- | --- |
| DOCX | 使用 `docx-preview.renderAsync()`，分页、页阴影、缩放 |
| PDF | 使用 `pdfjs-dist`，按页面 lazy render canvas，支持缩放 |
| PPTX | 使用 `pptx-preview`，复用客户端 PPTX 修复逻辑；桌面端缩略图，移动端纵向列表 |
| XLSX/CSV/TSV | 使用 `xlsx` 解析，展示 sheet tabs、合并单元格和表格网格 |
| XLS | 若开放，使用 `xlsx` 尝试解析；失败后降级下载 |

### FR-6: 审核策略

文档分享必须进入现有异步内容审核流程。创建或更新返回链接后，`moderationStatus` 初始为 `pending`；审核通过后为 `passed`，需要人工判断时为 `review`，审核异常为 `error`，明确拒绝时为 `rejected` 并自动关闭分享。

新增文档审查服务，至少包含：

| 模块 | 职责 |
| --- | --- |
| `HtmlShareDocumentInspector` | 校验文档结构、宏、加密、外链关系、嵌入对象和文件类型 |
| `HtmlShareDocumentTextExtractor` | 提取标题、正文、页眉页脚、备注、表格单元格等文本 |
| `HtmlShareDocumentMediaExtractor` | 提取 OOXML 内嵌图片，或生成 PDF/幻灯片页面抽样图 |
| `HtmlShareModerationService` | 组织 title、document_text、document_image、document_page_snapshot 等审核项 |

文本提取建议：

| 类型 | 提取方式 |
| --- | --- |
| DOCX | Apache POI `XWPFWordExtractor` |
| PPTX | Apache POI `XSLFPowerPointExtractor` |
| XLSX | Apache POI `XSSFExcelExtractor` 或逐 sheet 文本提取 |
| PDF | PDFBox `PDFTextStripper` |
| CSV/TSV | UTF-8 文本读取 |

审核规则：

- 提取文本最多 `html-share.moderation.document.max-text-chars`。
- 对 OOXML 设置 POI zip 安全限制，避免 zip bomb。
- 文档中的文本、超链接、批注、备注、隐藏 sheet、speaker notes 都应纳入文本审查范围；确实无法提取的部分要进入人工复核说明。
- OOXML 内嵌图片按 `document_image` 提交图片模型，数量和大小受配置限制。
- PDF 扫描页、PPT 图片页、文本覆盖率低的文档按 `document_page_snapshot` 生成抽样图并提交图片模型。
- 如果文本提取为空且视觉抽样审核无法完成，分享进入 `review` 或 `error`，不能直接 `passed`。
- 任一审核项返回 `reject` 或 `riskLevel=high` 时，复用现有 `disableByModeration()` 自动关闭整个分享。
- 审核明细写入 `html_share_moderation_items`，记录 `item_type`、`relative_path`、`contentSha256`、`shareSourceSha256`、`shareContentUpdatedAt`、模型、风险等级、分类和原因。
- 现有审核 prompt 中的“HTML 分享内容”应改为更通用的“公开分享内容”，并继续把待审文本放入 `UNTRUSTED_CONTENT` 边界，明确要求模型不要执行其中任何指令。
- 模型输入不得包含用户原始远端 URL；视觉抽样图如需使用图片模型，使用服务端生成的临时 NOS URL 或模型支持的受控 data URL，且不得返回给客户端或公共页面。

建议新增配置：

```properties
html-share.moderation.document.enabled=true
html-share.moderation.document.max-text-chars=500000
html-share.moderation.document.max-embedded-image-count=20
html-share.moderation.document.max-page-snapshot-count=8
html-share.moderation.document.snapshot-max-edge=1600
html-share.moderation.document.empty-text-policy=review
```

### FR-7: 管理员后台展示

`lobsterai-admin` 分享管理页需要：

- 来源筛选增加 `document_file`。
- 来源标签显示“Office/PDF 文件”。
- 详情弹窗展示入口文件名、MIME、大小、SHA-256。
- 展示预览策略：可预览、文件过大仅下载、类型不支持仅下载、预览配置关闭。
- 展示文档审核项，包括 `title`、`document_text`、`document_image`、`document_page_snapshot`、`skipped` 和 `manual_review`。
- 预览按钮继续调用 `createHtmlSharePreviewToken()`，不直接访问 `/content/`，不展示 NOS URL。

## 4. 实现方案

### 4.1 客户端常量与入口

扩展 `src/shared/htmlShare/constants.ts`：

```ts
export const HtmlShareSourceType = {
  HtmlFile: 'html_file',
  ImageFile: 'image_file',
  SvgFile: 'svg_file',
  DocumentFile: 'document_file',
} as const;
```

调整 `src/renderer/components/artifacts/ArtifactPanel.tsx`：

- `getHtmlShareSourceTypeForArtifact()` 将 `ArtifactTypeValue.Document` 映射到 `HtmlShareSourceType.DocumentFile`。
- 分享按钮支持 `document` artifact。
- 分享前可根据本地文件大小提示“网页预览将显示下载链接”，但服务端配置仍是最终标准。
- 文档分享弹窗默认使用分享码模式；如果保留公开访问入口，UI 需要明确展示审核中、审核拒绝后自动关闭等现有规则。
- 客户端、主进程和 renderer 之间传递 sourceType 时必须引用集中常量，不新增裸字符串分支。

### 4.2 客户端文档打包

扩展 `src/main/libs/htmlShare/artifactFileSharePackager.ts`：

```ts
export type ArtifactFileShareSourceType =
  | typeof HtmlShareSourceType.ImageFile
  | typeof HtmlShareSourceType.SvgFile
  | typeof HtmlShareSourceType.DocumentFile;
```

文档打包规则：

- 支持本地 `filePath` 和 data URL 内容；首期不支持远程文档 URL。远程 URL 会扩大 SSRF、内容审核和可追溯边界，应在客户端直接拒绝，服务端也必须兜底拒绝。
- 客户端先做扩展名和大小校验，服务端仍做权威校验。
- `sourceSha256` 使用原始文档 bytes hash。
- zip 只包含一个入口文件。
- 文件名使用 `path.basename()` 后按现有规则清洗。
- zip 内不得包含预览 HTML、脚本、图片衍生物或外部引用清单，避免客户端把未审核资源带入公共页。

`clientSourceKey` 规则：

```text
本地文件：sha256("document_file:file:{normalizedPath}")
内联产物：sha256("document_file:artifact:{sessionId}:{artifactId}")
```

### 4.3 服务端 sourceType 与文件校验

`lobsterai-server` 的 `HtmlShareService` 新增服务端 sourceType 常量或枚举，并加入 `SOURCE_TYPES`。不要在 controller、mapper 或后台接口中散落 `"document_file"` 裸字符串。

```java
private static final String SOURCE_TYPE_DOCUMENT_FILE = "document_file";
```

文档校验规则：

| 类型 | 校验方式 |
| --- | --- |
| `.pdf` | 文件头必须以 `%PDF-` 开始 |
| `.docx` | ZIP，包含 `[Content_Types].xml` 和 `word/document.xml` |
| `.pptx` | ZIP，包含 `[Content_Types].xml` 和 `ppt/presentation.xml` |
| `.xlsx` | ZIP，包含 `[Content_Types].xml` 和 `xl/workbook.xml` |
| `.csv` / `.tsv` | 文本文件，无 NUL 字节 |
| `.xls` | 若开放，校验 CFBF magic `D0 CF 11 E0 A1 B1 1A E1` |

拒绝：

- 宏格式：`.docm`、`.xlsm`、`.pptm`
- 旧版 Word/PPT：`.doc`、`.ppt`
- 加密或密码保护文档
- 扩展名与 magic 不匹配
- zip 内路径逃逸、空文件、多文件
- OOXML zip bomb 或解压比、entry 数量、单 entry 大小超过 POI 安全阈值
- OLE 对象、ActiveX 控件、嵌入包、嵌入可执行内容、外部模板引用
- 会触发自动加载的 OOXML 外部关系，例如外部图片、外部对象、外部数据连接
- PDF JavaScript、Launch action、EmbeddedFiles、OpenAction 中的外部动作

普通超链接可以保留为待审核文本，但公共预览层首期不渲染为可点击外链；如后续放开，需要统一走 URL scheme 白名单和跳转确认。

### 4.4 服务端大小限制

`extractArchive()` 按 sourceType 使用不同阈值：

| sourceType | archive limit | single file limit | extracted limit |
| --- | --- | --- | --- |
| `image_file` | 现有图片专用限制 | 现有图片专用限制 | 现有图片专用限制 |
| `document_file` | `document.max-archive-bytes` | `document.max-file-bytes` | `document.max-file-bytes` |
| 其他 | 现有 `maxArchiveBytes` | 现有 `maxSingleFileBytes` | 现有 `maxExtractedBytes` |

`document_file` 必须要求 `files.size() == 1`。

### 4.5 服务端公共页分流

`HtmlShareStaticController.shareShellPage()` 增加分流：

```text
image_file/svg_file -> imageShareShellPage()
document_file -> documentShareShellPage()
其他 -> 现有 iframe HTML shell
```

`documentShareShellPage()` 在返回 HTML 前读取入口文件元数据并计算预览策略。可预览时输出配置 JSON：

```html
<script type="application/json" id="lobster-share-config">
{
  "shareId": "shr_xxx",
  "title": "report.docx",
  "entryFile": "report.docx",
  "contentType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "sizeBytes": 7340032,
  "sourceUrl": "/s/shr_xxx/content/?preview=1",
  "downloadUrl": "/s/shr_xxx/content/?download=1",
  "preview": {
    "maxPdfPages": 300,
    "maxSheetCells": 200000
  }
}
</script>
<script type="module" src="/s/_assets/office-preview/office-preview.js"></script>
```

不可预览时输出下载卡片，不包含 preview bundle，也不包含 `/content/?preview=1`。

公共页输出约束：

- 页面 canonical URL 始终是 `/s/{shareId}/`，不能把 `/content/` 或 NOS URL 当作分享链接展示或复制。
- shell 只输出必要元数据：文件名、MIME、大小、预览策略、同源预览 URL、同源下载 URL。
- 对 `preview.available=false` 的分享，HTML 不包含预览脚本、worker、预览 URL，也不做隐藏预取。
- 分享码校验通过后设置的访问 cookie 作用域限制为 `Path=/s/{shareId}/`，并设置 `HttpOnly`、`Secure`、`SameSite=Lax`。

### 4.6 下载响应

`HtmlShareStaticController.getFile()` 或 `HtmlShareService.getPublicFile()` 增加 `download` 参数处理：

- `download=1` 时设置 `Content-Disposition: attachment`。
- `preview=1` 只表示预览读取，不改变鉴权。
- 入口文件 `Cache-Control` 保持 `private, no-store`。
- 返回 `Vary: Cookie, Sec-Fetch-Site`，避免分享码 cookie 与跨站请求缓存混用。
- 返回 `Cross-Origin-Resource-Policy: same-origin` 和 `X-Content-Type-Options: nosniff`。
- 对 `Sec-Fetch-Site=cross-site` 且不是顶层导航的 `/content/` 请求返回 403，避免文档被第三方页面作为 `<img>`、`<iframe>`、`<script>` 或下载探测子资源引用。
- 始终由服务端读取 NOS 并代理返回，不返回 302、不返回签名 NOS URL。
- 下载是否计入访问统计需要产品确认，建议计入一次有效访问。

### 4.7 公共预览 bundle

建议在服务端仓库新增独立前端 bundle 源码目录，例如：

```text
lobsterai-server/src/main/share-preview/
```

构建输出到：

```text
lobsterai-server/src/main/resources/static/html-share/office-preview/
```

锁定与客户端一致的依赖版本：

- `docx-preview@0.3.7`
- `pdfjs-dist@4.10.38`
- `pptx-preview@1.0.7`
- `xlsx@0.18.5`

可以迁移客户端 `DocumentRenderer.tsx` 中的纯逻辑，但不要直接复制 React/Electron 组件。公共页 bundle 不应依赖 Redux、Electron preload、客户端 i18n 服务或本地文件 API。

bundle 约束：

- 所有依赖固定版本并随服务端构建产物发布，不从 npm CDN、unpkg、jsdelivr 或模型生成 URL 加载代码。
- `pdf.worker.mjs` 使用同源地址；不允许 worker 自行从远端拉取脚本。
- 预览代码只读取 `/s/{shareId}/content/?preview=1`，不接受页面参数覆盖为任意 URL。
- 渲染产物进入 DOM 前做后处理：移除 `script`、事件属性、`javascript:` / `data:` 跳转、外部图片、外部字体和外部样式。
- 预览失败、超时或资源超过前端阈值时立即切换到下载态，不继续重试下载原文档。

### 4.8 安全策略

文档 shell 使用同源静态资源和严格 CSP：

```text
default-src 'self';
script-src 'self' 'nonce-{nonce}';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self';
worker-src 'self' blob:;
object-src 'none';
base-uri 'none';
frame-ancestors 'self';
```

其他要求：

- 不输出 NOS URL、分享码 hash、用户 ID、客户端本地路径。
- `download=1` 继续受分享状态、分享码和管理员 preview cookie 保护。
- Office/PDF 预览静态资源不从外部 CDN 加载。
- 前端渲染失败时只显示下载按钮，不记录文件内容。
- 继续复用 HTML/图片分享的访问边界：`/s/{shareId}/` 是唯一可分享入口，`/s/{shareId}/content/` 只是受保护的同源内容端点。
- 对 shell、内容端点和预览静态资源分别设置缓存策略：shell 可短缓存或不缓存，内容端点 `private, no-store`，静态 bundle 可带版本 hash 长缓存。
- shell 响应加 `X-Frame-Options: SAMEORIGIN`；若 CSP `frame-ancestors` 与旧浏览器行为冲突，以拒绝第三方嵌入为目标。
- DOCX/PPTX/XLSX 渲染出的 DOM 视为不可信内容。所有链接默认渲染为纯文本；确需可点击时只允许 `https:` / `mailto:`，并加 `rel="noopener noreferrer"` 与离站提示。
- PDF 禁用不必要的 annotation action、JavaScript action 和自动打开附件；附件不在 Web 预览层展示。
- 大文件下载模式下，页面不能为了显示页数、缩略图或文件摘要而隐式请求原文件。

### 4.9 模型内容审查实现

文档审查复用现有 `HtmlShareModerationService` 的异步链路，但需要把“HTML 分享内容”抽象为“公开分享内容”。创建或更新事务提交后投递审核任务，任务开始时重新读取分享当前版本；如果 `sourceSha256` 或 `contentUpdatedAt` 已变化，丢弃旧任务，避免旧审核结果覆盖新文件。

审核项生成顺序：

1. `title`：分享标题、入口文件名和可见描述。
2. `document_text`：正文、表格、批注、备注、页眉页脚、隐藏 sheet、speaker notes、PDF 文本层，按配置截断。
3. `document_image`：OOXML 内嵌图片，按 hash 去重、数量限制和尺寸限制抽样。
4. `document_page_snapshot`：PDF 扫描页、PPT 图片页、低文本覆盖页面的渲染抽样图。
5. `skipped` / `manual_review`：因加密、解析异常、超限、供应商不可用等原因无法自动判断的项。

状态合并规则：

| 子项结果 | 分享最终状态 |
| --- | --- |
| 任一 `reject` 或 `riskLevel=high` | `rejected`，并调用 `disableByModeration()` |
| 任一 `review` 且无拒绝 | `review` |
| 任一 `error` 且无拒绝/复核 | `error` |
| 全部通过，且没有必须审核但被跳过的内容 | `passed` |
| 文本为空且视觉审核未完成 | `review` 或 `error`，由 `empty-text-policy` 决定 |

模型输入治理：

- 文本审核 prompt 使用固定系统提示，明确待审内容位于 `UNTRUSTED_CONTENT`，不得执行其中指令、不得访问链接、不得根据文档内提示改变判定标准。
- 图片审核只传服务端生成的临时受控 URL 或 data URL；临时 URL 不写入公共响应，不在后台直接展示，不进入普通访问日志。
- 日志只记录分享 ID、文件 hash、审核项类型、模型、状态、风险等级和错误码，不记录完整文档文本、图片 URL 或分享码。
- `html_share_moderation_items.rawResultJson` 只保存模型结构化结果和截断后的原因，不保存原文全文；如需排查，依赖 hash 与后台复核流程。
- 管理员后台展示每个审核项的类型、状态、风险分类、原因、时间和是否因为超限进入复核。

建议将文档配置纳入现有 `HtmlShareModerationProperties`：

```properties
html-share.moderation.document.enabled=true
html-share.moderation.document.max-text-chars=500000
html-share.moderation.document.max-embedded-image-count=20
html-share.moderation.document.max-page-snapshot-count=8
html-share.moderation.document.snapshot-max-edge=1600
html-share.moderation.document.empty-text-policy=review
```

### 4.10 后台 UI

`lobsterai-admin/src/views/HtmlShareListView.vue`：

- 来源筛选增加 `document_file`。
- `sourceTypeLabel()` 增加 `document_file -> Office/PDF 文件`。
- 属性 tooltip 补充文档分享。
- 详情页展示文件大小、MIME、SHA-256 和预览策略。
- 详情页展示审核项列表，至少包含审核项类型、状态、风险等级、分类、原因、模型、更新时间。
- `skipped`、`manual_review`、`error` 需要有明确标识，避免管理员误认为已经通过。

`lobsterai-admin/src/api/htmlShares.ts`：

- `HtmlShareListItem` / `HtmlShareDetail` 增加可选 `preview` 字段。
- `HtmlShareFileItem` 现有字段可复用。
- 如现有详情接口未返回审核明细，需要复用或扩展现有 moderation item 查询接口，而不是让后台直接读取 NOS 或 `/content/`。

## 5. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| 文件超过上传阈值 | 创建或更新返回 `HTML_SHARE_TOO_LARGE`，客户端提示无法分享 |
| 文件超过 Web 预览阈值 | 分享创建成功，公共页显示下载卡片，不加载预览资源 |
| 文件类型不支持 | 客户端预校验提示，服务端最终拒绝 |
| 文件后缀和 magic 不一致 | 服务端拒绝，返回不支持或参数错误 |
| 文档加密或密码保护 | 服务端拒绝或进入审核 `review/error`，不直接通过 |
| OOXML 包含宏、OLE、ActiveX、嵌入包 | 服务端拒绝 |
| OOXML 包含外部图片、外部对象、外部数据连接 | 服务端拒绝；普通超链接仅作为文本审核，不在预览中直接跳转 |
| PDF 包含 JavaScript、Launch action、附件 | 服务端拒绝或进入 `review/error`，公共预览不展示附件 |
| OOXML zip bomb 或解压超限 | 服务端拒绝并记录安全错误码 |
| 预览 bundle 渲染失败 | 公共页显示错误态和下载按钮，不白屏 |
| PDF 页数过多 | 预览端停止渲染并提示下载 |
| XLSX 单元格过多 | 预览端停止渲染并提示下载 |
| 分享码未验证 | `/s/{shareId}/content/` 和下载接口返回 403 |
| 第三方页面把 `/content/` 当子资源引用 | `Sec-Fetch-Site=cross-site` 子资源请求返回 403 |
| 未验证分享码时直接访问下载 URL | 返回 403，不泄露文件名之外的敏感信息 |
| 管理员预览 disabled 分享 | preview token 通过后允许查看，普通访问仍显示关闭页 |
| 审核 pending 期间访问分享 | 沿用现有策略允许访问；若后续审核拒绝，自动 disabled |
| 文本提取为空 | 执行视觉抽样审核；视觉审核失败则进入 `review/error` |
| 嵌入图片数量超过审核配置 | 抽样审核并记录 `skipped/manual_review`，不能静默通过 |
| 模型审核供应商超时或异常 | 标记 `error`，保留重试或后台人工处理入口 |
| 大文件仅下载模式 | 仍受分享码、preview token、跨站防护和下载响应头保护 |
| 老服务端不识别 `document_file` | 客户端展示“当前服务端暂不支持文档分享” |
| 生产预览出问题 | 通过 `html-share.document.preview.enabled=false` 降级为下载模式 |

## 6. 涉及文件

### LobsterAI 客户端

| 文件 | 改动 |
| --- | --- |
| `src/shared/htmlShare/constants.ts` | 新增 `HtmlShareSourceType.DocumentFile` |
| `src/main/libs/htmlShare/artifactFileSharePackager.ts` | 支持文档单文件打包、hash、大小和类型预校验 |
| `src/main/main.ts` | IPC 输入类型支持 `document_file` |
| `src/main/preload.ts` | 如类型约束需要，补充 document share 输入类型 |
| `src/renderer/components/artifacts/ArtifactPanel.tsx` | document artifact 显示分享入口，映射 sourceType |
| `src/renderer/services/i18n.ts` | 新增中英文分享文案 |

### lobsterai-server

| 文件 | 改动 |
| --- | --- |
| `config/HtmlShareProperties.java` | 新增 document 与 preview 配置 |
| `config/HtmlShareModerationProperties.java` | 新增 document 审核配置 |
| `service/HtmlShareService.java` | 新增 sourceType、MIME、文档校验、大小策略、下载响应支持 |
| `web/controller/HtmlShareStaticController.java` | 新增 document shell、下载模式和预览模式 |
| `service/HtmlShareModerationService.java` | 文档审核编排、状态合并、拒绝后关闭分享 |
| `service/HtmlShareModerationClient.java` | 审核 prompt 泛化为公开分享内容，支持文档图片/截图审核 |
| `service/HtmlShareDocumentInspector.java` | 新增文档结构、宏、外链、加密、危险动作校验 |
| `service/HtmlShareDocumentTextExtractor.java` | 新增文档文本提取 |
| `service/HtmlShareDocumentMediaExtractor.java` | 新增内嵌图片提取和页面抽样图生成 |
| `service/HtmlShareDocumentPreviewPolicy.java` | 建议新增预览可用性与不可预览 reason 计算 |
| `resources/mapper/HtmlShareMapper.xml` | 如返回 preview metadata，补充字段映射 |
| `sql/Vxx__html_share_document_file.sql` | 修正表注释或新增必要字段 |
| `src/main/share-preview/**` | 新增公共文档预览 bundle 源码 |
| `src/main/resources/static/html-share/office-preview/**` | 构建产物 |

### lobsterai-admin

| 文件 | 改动 |
| --- | --- |
| `src/api/htmlShares.ts` | 类型补充 preview 和 moderation item 字段 |
| `src/views/HtmlShareListView.vue` | 来源筛选、标签、详情预览策略和审核项展示 |

## 7. 验收标准

### 7.1 客户端验收

1. `document` artifact 在可分享条件下显示分享按钮。
2. `.docx`、`.pptx`、`.xlsx`、`.pdf` 能创建分享并返回 URL 与分享码。
3. 同一本地文件再次分享能查询到已有分享，并可更新内容。
4. 不支持格式在客户端有明确提示，服务端拒绝时错误文案可读。
5. 所有新增用户可见文案都有中英文 i18n。
6. 分享成功后复制的链接始终是 `/s/{shareId}/`，不是 `/content/` 或任何远端文件 URL。

### 7.2 服务端验收

1. `document_file` 被创建、更新、按来源查询接口接受。
2. 多文件 zip、路径逃逸、entryFile 不存在、扩展名与 magic 不一致均被拒绝。
3. 宏格式、加密文档、OLE/ActiveX、危险 PDF action、自动加载外部资源均被拒绝或进入 `review/error`，不能直接通过。
4. 文件超过上传阈值返回 `HTML_SHARE_TOO_LARGE`。
5. 文件超过 Web 预览阈值时，`/s/{shareId}/` 不包含 preview bundle，也不请求 `/content/?preview=1`。
6. `download=1` 返回 `Content-Disposition: attachment`、`Cross-Origin-Resource-Policy: same-origin`、`X-Content-Type-Options: nosniff`、`Vary: Cookie, Sec-Fetch-Site`，且不暴露 NOS URL。
7. 分享码模式下，未验证不能预览或下载，验证后可以下载。
8. `Sec-Fetch-Site=cross-site` 的 `/content/` 子资源请求返回 403。
9. 管理员 preview token 可以预览 disabled 分享，普通用户不能访问。
10. 文档审核能产生 `html_share_moderation_items` 明细，包含文本、图片、页面截图和跳过/复核项。
11. 文本提取为空且视觉审核失败时，最终状态不是 `passed`。
12. 任一审核项拒绝时，分享状态为 `rejected` 并自动 disabled。

### 7.3 公共页验收

1. DOCX 分页、页阴影和缩放可用。
2. PDF 多页 lazy render、缩放和滚动可用。
3. PPTX 桌面端缩略图切换可用，移动端布局不重叠。
4. XLSX 多 sheet、合并单元格和大表滚动可用。
5. 大文件下载卡片不白屏，不触发预览文件下载。
6. 渲染失败时降级为下载入口。
7. 公共页源代码和网络请求中不出现 NOS URL、分享码 hash、用户 ID 或本地路径。
8. DOCX/PPTX/XLSX 渲染出的链接默认不可点击，外部图片和字体不会被浏览器请求。

### 7.4 后台验收

1. 分享管理可以按 `document_file` 筛选。
2. 列表和详情正确展示来源类型、文件大小和审核状态。
3. 管理员预览打开服务端 preview token URL。
4. 大文件管理员预览同样显示下载模式。
5. 详情页能查看文档审核项，`review/error/skipped` 状态有明确原因。

## 8. 待确认问题

1. 下载是否计入访问统计。建议计入，因为用户成功获取了分享内容；如果只统计预览打开，大文件下载型分享会被低估。
2. `.xls` 是否首期开放。客户端 SheetJS 可尝试解析，但旧格式风险和兼容性弱于 `.xlsx`。
3. 文档上传上限是否采用 100 MiB。若网关、NOS 或套餐有更低限制，应以平台限制为准。
4. 文档审核提取为空时是否强制人工复核。安全上建议复核，但会增加后台处理量。
5. 文档图片和页面截图审核使用模型视觉能力还是全部进入人工复核。建议优先模型抽样审核，供应商不可用时进入 `review/error`。
6. 审核 pending 期间是否允许公开访问。当前方案沿用已有分享行为；如法务要求先审后发，需要对所有 sourceType 统一调整。
7. 临时截图或抽样图片的保存时长。建议仅保留审核任务必要时间，审核结果落库后清理临时对象。
