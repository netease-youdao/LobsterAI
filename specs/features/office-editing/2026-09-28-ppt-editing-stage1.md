# PPT 编辑第一阶段实现记录

日期：2026-09-28。在 [Office 模块结构](./2026-09-28-office-module-architecture.md) 的格式表上加入第三种格式 `.pptx`。定位与 Word、Excel 相同（用户确认）：在 LobsterAI 里让 AI 实时修改演示文稿，以及需要小改动时直接改，不替代 PowerPoint，只做高频功能。写回原则不变：以原始文件包为准，只改写变化的部件，编辑器表达不了的内容原样保留。本阶段没有生成安装包，也没有在 Windows、Linux 或 Microsoft PowerPoint 上人工比对（在 macOS 上用 WPS 打开核对过）。

## 用户可见的变化

- 面板里的 `.pptx` 由只读预览改为可编辑：左侧幻灯片缩略图，中间当前幻灯片，底部演讲者备注；状态栏、恢复与冲突选择、保存错误、只读说明、“查看编辑前副本”与 Word、Excel 相同。打不开时仍提供原来的预览、系统应用和重试。
- 显示：母版与版式上的装饰、背景（纯色、渐变、图片）、占位符继承的位置与文字样式（标题/正文/其他三类样式、各级项目符号与编号、行距与段前段后、自动缩小字号）、主题色与颜色变换、常用预设形状与自定义形状、线条虚线与箭头、图片裁剪与翻转、组合、表格（按表格样式近似绘制表头与镶边）、SmartArt（使用文件中保存的绘图）、嵌入对象的替代图片。图表、没有绘图的 SmartArt 与 EMF/TIFF 图片显示占位框，文件中原样保留。Calibri、Cambria、Arial 等缺失时用内置的等宽度替代字体排版（与 Excel 共用 `office-fonts`）。
- 编辑：单击选中形状，拖动移动、拖动控制点缩放（图片与组合保持比例，Shift 切换），方向键微移（Alt/⌘ 为 1 像素，连续微移算一步撤销），Delete 删除（带动画的对象拒绝并说明原因，避免 PowerPoint 报文件损坏），Esc 取消选择，Tab 在形状间切换。
- 文字：双击（或再次单击已选中的形状、按 Enter/F2）在原位输入，表格单元格同样可以直接改；空占位符显示“单击此处添加标题/文本”，输入后消失。回车新段落、Shift+回车换行、Tab/Shift+Tab 调整项目符号级别，粘贴只取纯文本，中文输入法组字过程中不写入。输入约 0.3 秒后写入文件模型，一次编辑过程算一步撤销；未改动的段落与文字格式原样保留。
- 工具栏：撤销/重做、新建幻灯片（沿用当前版式，标题幻灯片之后用“标题和内容”）、复制幻灯片、删除幻灯片、插入文本框（空着离开会自动移除）、字体、字号、加粗、斜体、下划线、删除线、字体颜色（主题色面板，与 Excel 共用）、左中右对齐。输入时作用于选中的文字（光标在词中时作用于该词），选中形状时作用于整个形状；⌘B/⌘I/⌘U 同样可用。
- 幻灯片列表：点击切换，拖动调整顺序，↑↓/PageUp/PageDown/Home/End 切换，Delete 删除；隐藏的幻灯片编号带删除线。缩略图在滚动到附近时才绘制。
- 备注：在底部直接输入，没有备注的幻灯片会按备注母版新建备注页。
- 添加到对话：选中形状后右上方出现“添加到对话”，把形状文字（表格按制表符分隔）连同“第 N 张幻灯片 · 形状名 #id”加入对话；输入时选中的文字同样可以加入。发给模型时提示可用 ppt_read 读取幻灯片与形状 id。
- 缩放：面板的缩放按钮 25%–400%，重置为适应窗口。
- 只读：带宏、修改密码或数字签名的文件以只读方式打开并说明原因。

## AI 工具

MCP 服务 `lobster-ppt`，工具 `ppt_read`、`ppt_edit`（托管 AGENTS.md 与 pptx 技能中有使用说明）：

- `ppt_read {path, slides?}`：返回 `revision`、幻灯片尺寸（磅）、版式名、每张幻灯片的版式、备注和形状（id、名称、类型、占位符角色、位置尺寸、按行的文字——前导制表符表示级别、表格单元格、所属组合），以及用户当前的选择。
- `ppt_edit {path, expectedRevision, edits}`：`set_text`、`replace_text`（可跨幻灯片查找）、`format_text`、`format_paragraph`、`set_table_cell`、`set_bounds`、`delete_shape`、`add_text_box`、`add_slide`（按版式名，填标题与正文）、`duplicate_slide`、`move_slide`、`delete_slide`、`set_notes`。一次调用按顺序执行、作为一步撤销；任何一步不合法则整批不改（事务回滚），并说明第几步、为什么。修订号不符时拒绝，要求重新读取。
- 调用完成后面板切到被修改的幻灯片并选中改动的形状，立即保存，返回新的 `revision`。

## 实现

渲染端 `src/renderer/services/office/slides/`，不引入新依赖（fflate 已有）：

| 模块 | 职责 |
|---|---|
| `slidesXml.ts` | 命名空间感知的 DOM 访问；浏览器用 DOMParser，测试用 @xmldom/xmldom（`XmlCodec`） |
| `slidesPackage.ts` | 部件级文件包：XML 按需解析、只重写改过的部件、事务（记录改动前后内容，失败回滚）、撤销/重做、关系与内容类型 |
| `slidesDeck.ts` | 幻灯片顺序、版式/母版/主题/备注、增删复制移动（节 `p14:sectionLst` 与自定义放映同步、删除后回收只被它使用的图片和备注） |
| `slidesText.ts` | 文字读写：保留段落与 run 属性的整体替换、按范围替换与设置格式（按 schema 顺序写 `a:rPr`）、把原位编辑的段落写回 |
| `slidesShapes.ts` | 形状寻址（含组合成员）、位置写回（继承位置的占位符会得到自己的 `a:xfrm`）、删除、文本框 |
| `slidesTheme.ts`、`slidesModel.ts`、`slidesGeometry.ts` | 主题色与颜色映射、占位符继承链、文字样式链、填充线条、表格、组合与 SmartArt，得到可绘制的 `SlideView` |
| `slidesRender.ts` | 把 `SlideView` 画成 HTML/SVG；段落与 run 带回指原 XML 的位置 |
| `slidesTextEditing.ts` | contenteditable 与段落偏移之间的换算（选区、光标、分词） |
| `slidesAgentOperations.ts` | `ppt_read`/`ppt_edit` 的读取与校验 |
| `slidesEditorSession.ts` | 编辑会话（继承 `OfficeEditorSession`）：缩略图、舞台、选择与拖动、原位输入、撤销栈、备注、Agent 接口 |

要点：

- 保存以原始文件包为基础，未触碰的部件逐字节保留；撤销到最初时部件回到原始字节。媒体以 STORED 写入，XML 压缩级别 6，条目时间固定，同样内容两次保存字节相同。
- 占位符文字的原位编辑只替换变化的段落；Chromium 回车拆出的新段落继承原段落属性，run 通过 `data-run` 保留格式。
- 字体、颜色面板抽到 `services/office/core/officeFonts.ts`、`officeColors.ts`，Excel 改为使用共享版本。
- 主进程 `src/main/office/slides/`：`inspectSlidesPackage`（主文档、Strict 格式拒绝、宏/修改密码/签名只读），`SLIDES_FORMAT` 加入 `MAIN_OFFICE_FORMATS`；限制为文件 80 MB、解压后 400 MB、单部件 150 MB、1 万个部件。`officeZip` 的拒绝函数改为函数声明，使严格模式的控制流分析认得它们不返回。

## 验证

- 单元测试（Vitest，Node 下用 @xmldom/xmldom，已加入 devDependencies）：`slidesPackage`（原样保存、只写改动部件、回滚/撤销/重做、关系目标编码）、`slidesDeck`（增删复制移动与节、备注创建、图表幻灯片拒绝复制）、`slidesText`、`slidesModel`（继承、文字颜色优先级、表格样式、默认形状白字）、`slidesAgentOperations`（读取、批量编辑、原子回滚、错误说明），以及 `inspectSlidesPackage`、`officeFileStore` 的 PowerPoint 测试包、选区提示标题。编辑器写出的文件都经主进程准入校验。
- 隔离实例端到端（独立用户目录、端口 5176/9224、脚本化模拟模型，不消耗真实模型）：配置同步写入 3 个 Office MCP 服务，OpenClaw 暴露 `lobster-ppt__ppt_read/ppt_edit`；一次对话完成读取与两处修改（改标题、新建备注页），面板切到对应幻灯片，一步撤销/重做整批修改。真实输入事件验证了原位输入（含中文输入法组字）、拖动与缩放、微移合并撤销、带动画对象的删除拒绝、删除后撤销重做、表格单元格、备注、新建/复制/删除/拖动排序幻灯片、文本框、只读文件、外部修改后自动重新加载、添加到对话。
- 写回校验：编辑后的两份文件（含节、动画、表格、备注的测试包；pptxgenjs 生成的含渐变图片、箭头线、图表的演示文稿）用 `SKILLs/pptx/ooxml` 的校验器通过全部检查（校验器对节列表中重复的幻灯片 id、以 `/` 开头的关系目标有两处误报，在临时副本中修正后复核），并在 WPS 中打开核对：顺序、文字、局部红色加粗、移动的形状、表格、备注与未触碰的图表都正确。
- 流畅度（60 页、22 MB 图片的演示文稿）：打开到显示当前幻灯片 0.24 s，首屏只绘制可见附近的 12 张缩略图；连续输入按键到下一帧中位 27 ms、P95 33 ms，无长任务；停止输入约 1 s 后自动保存，期间有 53–140 ms 的长任务（打包 22 MB 与跨进程传输），常见规模的文件成比例更小。

## 暂不支持（原样保留）

图表与 SmartArt 的编辑、插入图片/形状/表格、动画与切换效果、主题与版式编辑、批注、多选与对齐分布、旋转手柄、竖排文字的原位输入效果、放映。含图表/SmartArt/嵌入对象的幻灯片暂不支持复制。
