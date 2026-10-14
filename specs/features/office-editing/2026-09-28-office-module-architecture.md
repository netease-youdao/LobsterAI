# Office 编辑模块结构

日期：2026-09-28。Word 与 Excel 编辑完成后、开始 PPT 之前做的一次结构整理。目标是让三种格式共用同一套文件协议、Agent 通道和编辑器外壳，新增格式只写格式自己的部分。本次不改变用户可见行为，也不改变任何持久化名称。PPT 随后按本文“新增一种格式”一节接入，见 [PPT 编辑第一阶段](./2026-09-28-ppt-editing-stage1.md)。

## 整理前的问题

- Excel 基于通用的 Office 层实现，Word 早于它，保留着一整套副本：文件存储、ZIP 校验、IPC 注册、Agent 桥、MCP 服务、共享类型、文档状态机、渲染端 Agent 桥，另有两份几乎相同的会话注册表。
- 每种格式在 `main.ts`、preload、`electron.d.ts`、`openclawConfigSync`、`mcpBridgeServer`、`mcpRuntime`、`App.tsx`、`ArtifactPanel`、`DocumentRenderer` 里各有一份接线。
- 两边各自修过的问题没有互相同步：Excel 拒绝写入会变成只读的快照，Word 没有；Word 只保留包信息，通用版把每次读到的文件字节挂在文档上；通用 `OfficeDocument` 没有测试；面板缩放按钮只允许 50%–200%，编辑器却允许 25%–300%/400%。

## 目录

```
src/shared/office/
  core/officeFile.ts      文件与 Agent 契约、OfficeFileError、officeFileChannels(id)
  core/officeEditor.ts    OfficeEditorId、OfficeEditorSpec
  word/  sheet/  slides/  各格式的包信息、只读原因、限制、工具定义与提示
  editors.ts              OFFICE_EDITORS 格式描述表、OfficeBridges、officeEditorForPath
src/main/office/
  core/                   OfficeFileStore、officeZip、OfficeAgentBridge、officeMcpServer、registerOfficeFileHandlers
  word/  sheet/  slides/  包校验（wordPackage/sheetPackage/slidesPackage）、格式定义（*_FORMAT）、Word 字体目录
  officeEditing.ts        OfficeEditing：按格式表注册 IPC、退出保护、Agent 调用、MCP 服务
  formats.ts              MAIN_OFFICE_FORMATS
  officePreloadBridges.ts preload 里的 window.electron.artifact.office
src/renderer/services/office/
  core/                   OfficeDocument、OfficeEditorSession、createOfficeEditorRegistry、createOfficeAgentHandler、
                          替代字体注册（officeFonts）、主题色面板（officeColors）
  word/  sheet/  slides/  编辑会话、Agent 操作、字体、xlsx 编解码、pptx 文件包与绘制
  officeFormats.ts        RENDERER_OFFICE_FORMATS、installOfficeAgentBridges、refreshOpenOfficeEditor
src/renderer/components/artifacts/renderers/office/
  common/                 OfficeEditorShell/Loader、缩放、预览操作上下文、工具栏基础件、调色板、公共样式
  word/  sheet/  slides/  各格式的编辑器、工具栏与只读预览
  officeEditors.tsx       面板里每种格式的编辑器与预览（officeDocumentView）
src/renderer/assets/office-fonts/   内置 OFL 字体，Word、Excel、PPT 共用
```

`src/renderer/services/documentLifecycle.ts`（原 `markdownDocumentLifecycle.ts`）由 Markdown 与 Office 编辑器共用。

## 格式描述表

`OFFICE_EDITORS` 中每一项（`OfficeEditorSpec`）给出所有进程都要知道的内容：id、扩展名、IPC 通道、MCP 服务名、工具定义、超时和可选的托管提示。各层再各有一张小表，只放本层独有的部分：

| 层 | 表 | 格式自己提供的部分 |
|---|---|---|
| 主进程 | `MAIN_OFFICE_FORMATS` | 包限制、`inspect` 校验、日志标签、格式专有通道（Word 的系统字体） |
| 渲染服务 | `RENDERER_OFFICE_FORMATS` | 懒加载的 Agent 处理器与刷新函数 |
| 面板组件 | `OFFICE_EDITOR_VIEWS` | 懒加载的编辑器组件、只读预览、选区加入对话 |

主进程注册、preload、MCP 配置同步、Agent 请求分发、面板刷新和文档分发都遍历这些表，不再出现按格式写死的接线。

## 各层的公共部分

- 主进程：`OfficeFileStore`（按拥有者发放句柄、按规范路径串行写入、恢复草稿、首次覆盖前留原始副本、带版本校验的原子替换；Windows 上文件被 Excel/WPS 等程序占用时，打开和读取结果带 `inUse`，保存报 `in-use`，替换被拒时短暂重试）、`readOfficeZip`（解压前检查限制、CRC、拒绝 ZIP64/加密/DTD/非 UTF-8、严格解码字符引用）、`OfficeAgentBridge`（只接受主窗口顶层 frame 的回复，每次调用都有超时）、`resolveOfficeMcpStdioLaunch`（生成 stdio MCP 服务与 `runtime.json`）。
- 渲染服务：`OfficeDocument`（修订号、恢复草稿、自动保存、外部修改仲裁；文件被占用时保存转为等待，占用程序的锁文件消失或回到窗口时补存；只保留文件句柄和包信息，不保留字节）；`OfficeEditorSession` 基类（宿主元素在面板和屏幕外停放区之间移动，保存与释放句柄）；`createOfficeEditorRegistry`（每个文件一个会话、HMR 保持、退出保护、外部修改刷新、在 React 提交之后回收空闲会话）；`createOfficeAgentHandler`（同一文件的调用串行、在面板中显示文件、只读/待解决冲突/修订号检查、未知工具拒绝）。
- 面板组件：`OfficeEditorLoader`（打开中状态、失败时提供预览/系统应用/重试）、`OfficeEditorShell`（保存状态、恢复与冲突选择、保存错误、被其他程序占用的提示、只读说明、Cmd/Ctrl+S、页脚的编辑前副本）、`OfficeToolbar*`（按钮、分隔线、字体与字号菜单）、`OfficeSplitButton`、`OfficeColorButton`、统一的缩放范围 25%–400%，以及 `office*` 文案。

## 不能改的名称

这些名称已经写入用户数据、OpenClaw 配置或 Agent 的习惯，改动需要迁移：

- 编辑器 id `word`、`sheet`、`slides`：决定 IPC 通道 `artifact:<id>:*`、工具回调地址 `/<id>/tool`、草稿目录 `userData/<id>-drafts`。
- `userData/word-fonts/catalog.json`（Word 系统字体目录缓存）。
- MCP 服务名 `lobster-word`、`lobster-excel`、`lobster-ppt`，工具名 `word_read`/`word_edit`/`excel_read`/`excel_edit`/`ppt_read`/`ppt_edit`。
- 选区来源 `artifact_word`、`artifact_sheet`、`artifact_slides`。

Word 的 MCP 运行时文件原名 `lobster-word-mcp-runtime.json`，现在与 Excel 一样叫 `runtime.json`；生成时会删除旧文件（其中有 bridge secret）。

## 新增一种格式（以 PPT 为例）

1. `src/shared/office/slides/`：包信息与只读原因、限制、`ppt_read`/`ppt_edit` 工具定义；在 `OfficeEditorId` 与 `OFFICE_EDITORS` 各加一项，在 `OfficeBridges` 加上它的桥类型。
2. `src/main/office/slides/`：用 `readOfficeZip` 写 `inspectSlidesPackage`，定义 `SLIDES_FORMAT` 并加入 `MAIN_OFFICE_FORMATS`；在 `createOfficeBridges` 加一行。
3. `src/renderer/services/office/slides/`：继承 `OfficeEditorSession` 写编辑会话，用 `createOfficeEditorRegistry` 导出 acquire/refresh，用 `createOfficeAgentHandler` 写 Agent 处理器，加入 `RENDERER_OFFICE_FORMATS`。
4. `src/renderer/components/artifacts/renderers/office/slides/`：编辑器组件套用 `OfficeEditorLoader`/`OfficeEditorShell` 和工具栏基础件；在 `OFFICE_EDITOR_VIEWS` 加一项，预览沿用 `PptxPreview`。
5. 格式专有文案用 `slides*` 键，其余用现有 `office*` 键；在 `CoworkSelectedTextSource` 加选区来源和提示标题。

`main.ts`、`preload.ts`、`openclawConfigSync`、`mcpBridgeServer`、`mcpRuntime`、`App.tsx`、`ArtifactPanel` 与 `DocumentRenderer` 都不需要修改。参数化测试会覆盖新格式：`officeFileStore.test.ts` 需要为它加一组测试包，其余测试直接遍历 `OFFICE_EDITORS`。

PPT 接入时实际改动与此一致：主进程、preload、配置同步与 MCP 接线均未改；preload 与 `electron.d.ts` 只在选区来源的联合类型里加了 `artifact_slides`；`DocumentRenderer` 中原先直接渲染 `.pptx` 预览的分支已被格式表取代，随之删除。

## 测试

- `src/shared/office/editors.test.ts`：固定现有 IPC 字符串，检查 id、扩展名、通道、服务名、工具名互不重复。
- `src/main/office/core/*.test.ts`：文件存储（原子保存、冲突、恢复、路径队列、只读）、Agent 桥、MCP 服务，对每种格式各跑一遍。
- `src/main/office/{word,sheet}/*Package.test.ts`：各格式的准入规则。
- `src/renderer/services/office/core/officeDocument.test.ts`：文档状态机，对 Word、Excel 的包信息各跑一遍（原 Word 的 14 个用例，加上导出被拒与不保留字节）。
- `src/renderer/services/office/slides/*.test.ts`：pptx 文件包、结构操作、文字、绘制模型与 Agent 操作（Node 下用 @xmldom/xmldom 解析 XML）。

## 有意保留的结构

- `sheet/` 下的 xlsx 编解码没有拆到子目录：它和 `sheetStructure`、`sheetAddress`、图表模块双向引用，拆开只会增加跨目录引用。
- `sheetUniverUi`、`sheetValidationPrompt` 仍从服务层引用 Excel 的 Univer 视图组件：Univer 实例随会话创建，Agent 打开表格时面板可能还没有挂载，不能改为由面板注册。
- `useEditorSelectionChat` 留在 `artifactSelectedText.tsx`，与面板预览的选区对话共用定位逻辑；PPT 的文字层也可以使用。
