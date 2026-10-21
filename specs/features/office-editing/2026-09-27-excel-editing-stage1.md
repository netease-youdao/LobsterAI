# Excel 编辑第一阶段实现记录

日期：2026-09-27。范围：本地 `.xlsx` 在右侧面板的人工编辑、自动保存与恢复、外部修改仲裁，以及 Agent 实时编辑正在显示的工作簿。设计背景见[总体方案](./2026-09-13-office-editing-design.md)，保存与冲突协议沿用 [Word 第一阶段](./2026-09-13-word-editing-stage1.md)。本阶段没有生成安装包，也没有在 Windows、Linux、Microsoft Excel 或 WPS 上做人工比对。

## 使用方式

更新依赖后运行 `npm run electron:dev`，从任务产物或“我的文件”打开本地 `.xlsx`，符合编辑范围的文件直接进入编辑器；`.xls`、`.csv`、`.tsv`、没有本地路径的内容和不能编辑的工作簿继续使用原有预览，编辑器打不开时可以一键切回预览或用系统应用打开。

支持：单元格值与公式（输入 `=` 开头即为公式，依赖单元格实时重算）、字体、字号、加粗/斜体/下划线/删除线、字体颜色、填充色、对齐、自动换行、边框、数字格式（含工具栏的常规/数值/千分位/百分比/货币/日期/文本）、列宽、行高、隐藏/取消隐藏行列、合并/取消合并、复制粘贴、自动填充、撤销/重做和多工作表切换。

停止编辑约 1 秒后自动保存，也可以使用保存按钮或 Cmd/Ctrl+S。切换文件、关闭面板不会销毁工作簿会话，重新打开仍能继续编辑和撤销。外部程序或 Agent 改写文件时：没有本地修改就自动载入新内容；存在本地修改则暂停自动保存，显示“保留我的编辑 / 使用文件版本”，两项都需要二次确认。

暂不支持保存回 Excel 文件的操作在界面上隐藏，在命令层拒绝，并提示用户用 Excel 或 WPS 完成：插入、删除、移动行列或工作表，重命名、隐藏工作表，冻结窗格，保护，定义名称，整行/整列样式，网格线和工作表标签颜色。（第二阶段已支持其中的行列插删、工作表增删改名排序隐藏、冻结和标签颜色，见[第二阶段记录](./2026-09-27-excel-editing-stage2.md)。）

## 实现和文件边界

| 责任 | 实现 |
| --- | --- |
| 表格内核 | Univer 1.0.2 的 Apache-2.0 开源包（core、engine-render、engine-formula、ui、design、docs、docs-ui、sheets、sheets-ui、sheets-formula、sheets-formula-ui、sheets-numfmt、sheets-numfmt-ui），不含任何 `@univerjs-pro` 包、包含商业插件的预设或转换服务 |
| XLSX 读写 | 自研：`src/renderer/services/sheet/xlsxImport.ts`、`xlsxExport.ts`、`xlsxStyles.ts`、`xlsxPackage.ts`、`xlsxXml.ts` |
| 编辑会话 | `sheetEditorSession.ts`：Univer 实例、命令拦截、改动追踪、离屏停放、字体与行高准备 |
| 保存协调 | `src/renderer/services/officeDocument.ts`：revision、恢复副本、保存队列、外部刷新和冲突选择 |
| 本地文件通道 | `src/main/libs/officeFileStore.ts`、`src/main/ipcHandlers/officeFileHandlers.ts`、`sheetEditing.ts` |
| XLSX 准入 | `src/main/libs/officeZip.ts`（ZIP 与 XML 安全检查）、`sheetPackage.ts`（只读原因与未显示内容） |
| Agent 工具 | `lobsterOfficeMcpServer.ts`、`officeAgentBridge.ts`、`src/renderer/services/sheet/sheetAgent.ts`、`sheetAgentOperations.ts` |
| 界面 | `src/renderer/components/artifacts/renderers/sheet/SheetFileEditor.tsx`、`SheetToolbar.tsx`，Univer 自带工具栏不显示 |

`office*` 前缀的模块是从 Word 实现泛化出的公共层，协议与 Word 相同。Word 本阶段没有迁移到这些模块，以免改动已经验证的 Word 代码；后续可以单独迁移。

### 文件往返

写回以原始文件包为准：每次保存把当前快照与打开时的基线逐格比较，只改写变化的单元格、行、列和合并区域，其他部件和未改动的 XML 元素保持原样。新样式在原记录基础上派生新的 `cellXfs` 记录，保留保护、主题字体等编辑器不理解的属性；新文字以内联字符串写入，不改动 `sharedStrings.xml`。

公式相关规则：

- 打开时只计算没有缓存结果的公式，文件自带的结果保持显示；保存前等待重算完成，把结果写入缓存值，openpyxl 等不重算的读取方也能读到正确数值。
- 没有被改动的公式，如果引擎算出错误值（通常是引擎缺少 Excel 的某项能力），保留文件原有结果，不写入错误。
- 单元格有改动时删除 `calcChain.xml`，并设置 `fullCalcOnLoad`，让 Excel 打开时重算。
- 改写的公式补回 `_xlfn.` / `_xlfn._xlws.` 前缀。共享公式的主单元格被改写时，同组其余单元格改写为普通公式，避免文件损坏。
- 表格（套用表格格式的区域）注册到公式引擎，`Sales[金额]` 这类结构化引用可以计算；表头被修改时同步表定义列名，表头为空、重复，或有公式按列名引用该表时拒绝保存并提示撤销。
- 写回器不能表达的变化（结构改动、共享公式无法展开等）会拒绝保存并提示撤销，恢复副本继续保留，不会写出有损文件。

显示相关处理：本机缺少 Calibri、Cambria、Arial、Times New Roman、Courier New 时，用 Word 已内置的等宽度量字体（Carlito、Caladea、Liberation）替代，避免数字因回退字体变宽显示成 `####`；列宽按实际渲染字体测得的数字宽度换算。文件中没有固定行高、含换行或多行文本的行，打开时按内容自动增高；这只影响显示，不写回文件。

## 当前准入与兼容性范围

- 拒绝进入编辑：加密（OLE 容器）、Strict Open XML、ZIP64、多卷 ZIP、DTD/实体声明、结构损坏的包；文件超过 20 MiB、解压总量超过 200 MiB、单个部件超过 100 MiB、超过 4096 个 ZIP 项目或 50 万个单元格。
- 只读打开：工作表保护、数据透视表、数组公式/数据表/动态数组、外部工作簿链接、外部数据连接、数字签名、宏。主进程按会话记录可写状态，只读会话的恢复副本和保存都会被拒绝；编辑器生成的文件如果被准入判定为只读内容，同样拒绝写入。
- 原样保留但暂不显示：图表、图片、批注、条件格式、数据验证、超链接、图表工作表。编辑器底部列出当前文件包含的这些内容。（第二阶段起除图表工作表和个别无法绘制的对象外均已显示并可编辑。）
- 富文本单元格未修改时保留原格式；修改后按纯文本保存。

## Agent 实时编辑

链路与 Word 相同：OpenClaw 原生 MCP 服务 `lobster-excel`（生成于 OpenClaw state 的 `generated/lobster-excel-mcp`，用 Electron Node 运行）→ 主进程回环桥接 `/sheet/tool`（进程密钥鉴权）→ 主窗口顶层 frame → 渲染进程的工作簿会话。

- `excel_read`：打开或复用会话，返回 revision、各工作表及已用范围、指定范围内的非空单元格（普通值直接给出，有公式或格式化显示时给出 `{value, formula, text}`）、合并区域、用户当前选区，以及“保留但未显示”的内容类型；大范围按行截断并给出下一段范围。
- `excel_edit`：`set_values`、`set_formula`（按 Excel 填充规则调整相对引用）、`clear`、`format`、`set_column_width`（Excel 字符单位）、`set_row_height`（磅）、`merge`、`unmerge`。

所有编辑先整体校验，任何一项无效则都不执行；执行中途失败则整体回滚。一次调用在 Univer 撤销栈中合并为一步（`beginUndoRedoGroup` 的 append 模式），用户按一次撤销即可撤回整次 AI 修改。`expectedRevision` 与当前 revision 不一致时拒绝并要求重新读取；同一工作簿的调用串行执行。编辑后等待重算，把编辑区域内的公式错误返回给模型，并自动保存。

LobsterAI 管理的 AGENTS.md 段落新增一条说明：修改现有 `.xlsx` 时优先使用这两个工具，只有工具做不到的操作才改用文件脚本。本阶段没有修改 `SKILLs/xlsx`。

## 商业发行与开源材料

LobsterAI 自有代码（包括 XLSX 读写器）保持 MIT；第三方包保留各自许可。

- 新增直接依赖：13 个 `@univerjs/*` 1.0.2、`rxjs` 7.8.2、`fflate` 0.8.3，均固定精确版本。仓库不提交 lockfile，因此在 `overrides` 中按 Univer 包分组固定了 106 个传递依赖版本，保证 CI 的全新安装与审查过的清单一致。
- `resources/sheet-licenses/NOTICE.txt` 与 `manifest.json` 记录 117 个包的许可材料与哈希。依赖图中出现 `@univerjs-pro/*` 或白名单外许可证（MIT、Apache-2.0、BSD-3-Clause、ISC、0BSD 以外）时脚本直接失败。
- 发布包中缺少完整许可文本的依赖从各自项目补齐：`react-remove-scroll-bar` 2.3.8 采用作者后来在上游提交 7301c160 中补充的 MIT LICENSE（2.3.8 元数据与 README 均声明 MIT）；`franc-min` 6.2.0 采用 npm gitHead 3f9f0b51 的 license；`ot-json1`、`ot-text-unicode`、`unicount` 采用其 README 中的 License 段；`@univerjs/protocol` 采用 Univer 仓库许可证。这些判断建议随发行物料一起复核。
- `npm run verify:sheet-licenses` 已加入 `prebuild`；三个平台的打包配置均包含 `licenses/sheet`。本次没有生成安装包，也未检查最终产物。

渲染进程构建沿用项目的 `minify: false`，Excel 编辑器是按需加载的独立分块，约 13.9 MB（gzip 约 2.6 MB），只在打开 `.xlsx` 或 Agent 调用 Excel 工具时加载。

## 验证记录

- 单元测试：XLSX 导入映射、逐格补丁写回、样式派生、列宽行高与合并、共享公式拆组、结构改动拒绝、表头同步、函数前缀；引擎往返（跨表重算、共享公式、补写缓存值、工具栏式样式）；Agent 读取、编辑、一步撤销、无效编辑零改动、公式错误报告；命令拦截对 Univer 实际注册的全部结构性命令生效；ZIP 准入与只读分级；文件存储的恢复副本、冲突、只读拒写；MCP 服务收发与鉴权；工具桥接；配置同步注册 `lobster-excel`。新增 11 个测试文件全部通过。
- 完整 `npm test`：17 项失败，集中在 `nspClawguardInstallRepair`、`nspClawguardCompatibility`、`openclawCompatibilityRepairCore` 三个文件；在暂存全部改动后的干净代码上同样失败，与本阶段无关。
- `npm run build`（含两套许可校验）、`npm run compile:electron`、全部改动文件的 ESLint：通过。
- 独立读取校验：用 openpyxl 生成 AI 报表式工作簿（样式、合并、冻结、列宽、公式、日期、数据验证、条件格式、批注、图表、表格），经编辑与导出后再由 openpyxl 读回：值、公式、重算后的缓存值、样式、数字格式、合并、冻结、列宽正确，图表、批注、数据验证、条件格式、表格均保留。
- 端到端（macOS，隔离数据目录，Vite 开发服务器 + Electron + CDP）：
  1. 真实 `SheetFileEditor` 打开上述工作簿：表头样式、货币与百分比格式、未缓存公式的计算结果正确；日期列不再显示 `####`；多行文本行自动增高。
  2. 鼠标选中单元格后键盘输入并回车：自动保存落盘，依赖公式、合计、另一工作表的 `SUM(Detail[数量])` 结果随之更新。
  3. 工具栏加粗落盘；插入行被拒绝，数据不变并显示说明。
  4. 页面内调用 Agent 工具：读取返回公式、显示文本和选区；一次编辑写入值、填充公式、格式和列宽并保存；过期 revision 与无效编辑均不改动工作簿；一次 Cmd+Z 撤回整次 Agent 修改，用户之前的格式保留，撤销结果自动保存。
  5. 外部程序改写文件：无本地修改时自动载入；有本地修改时进入冲突确认，二次确认“保留我的编辑”后写入并清理恢复副本，编辑前副本已保留。
  6. 卸载再挂载编辑视图：复用同一会话，网格正常铺满，撤销历史可用。
  7. 配置指向本地脚本化模型的自定义模型后，OpenClaw 注册 `lobster-excel__excel_read/excel_edit`；模型依次读取、编辑，从发起任务到修改落盘约 1 秒，openpyxl 读回公式、缓存值和格式正确。

端到端过程中发现并修复：结构性命令的拦截正则漏掉带后缀的命令 ID；关闭 Univer 自动聚焦后，选中单元格直接打字无法进入编辑；保存可能早于重算开始，导致新公式没有缓存值；缺少 Office 字体时列宽不足以显示数字；Univer 把形似日期的文本误标为“文本型数字”。

## 已知限制与后续

- ~~插入、删除、移动行列和工作表、重命名工作表、冻结窗格还不能写回~~；~~图表、图片、条件格式、数据验证只保留不显示~~：均已在[第二阶段](./2026-09-27-excel-editing-stage2.md)实现（移动行列仍不支持）。透视表、迷你图仍属于 Univer Pro 功能，未显示。
- 每次保存都会逐格比较整张有改动的工作表，大工作簿的保存耗时尚未测量；可以改为按命令记录脏区域。
- 整行/整列样式没有导入，空白单元格在这些行列中的显示与 Excel 可能不同。
- 未在 Windows、Linux、Microsoft Excel 和 WPS 上人工打开核对，未验收原生中文输入法候选窗。
- `excel_read` / `excel_edit` 与 Word 工具一样接受任意本地路径，对所有会话注册、不区分 OpenClaw 沙箱模式；权限模型应与 Word 一起调整。
- Word 可以迁移到 `office*` 公共层，删除重复的保存和文件通道代码。
