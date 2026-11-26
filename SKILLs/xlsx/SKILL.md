---
name: xlsx
description: "创建、编辑、分析与校验 Excel 电子表格（.xlsx/.csv），支持右侧实时编辑、动态公式与零错误校验。"
license: Proprietary. LICENSE.txt has complete terms
official: true
version: 2.0.0
---

# XLSX 电子表格创建与编辑指南

请全程使用与用户输入一致的语言进行思考、过程说明与最终交付。参考脚本路径请基于本技能目录（`<skill_dir>`）解析。

## 一、任务路由（按场景选最简方案）

1. **编辑已有 `.xlsx`（改数据、写公式、调样式/列宽/行高、合并单元格、增删行列/工作表、冻结窗格、选区"修改这里"）**
   - **优先使用 LobsterAI 实时编辑工具 `excel_read` + `excel_edit`**（若工具未挂载，调用 `lobster_enable_tools({ capabilities: ["excel"] })` 或已随本技能自动解锁）。
   - 修改会在右侧表格编辑器实时生效、**自动重算所有公式**、保留未改动部分的格式/图表/数据验证并自动保存：
     1. 先调 `excel_read({ path, sheet?, range? })` 获取 `revision`、工作表使用范围、单元格值/公式、合并区域与用户当前 `selection`。
     2. 再调 `excel_edit({ path, expectedRevision, edits })`，支持 `set_values`（以 `=` 开头即公式）、`set_formula`（自动相对引用填充区域）、`clear`、`format`、`set_column_width`、`set_row_height`、`merge`/`unmerge`、`insert_rows`/`delete_rows`、`insert_columns`/`delete_columns`、`add_sheet`/`rename_sheet`/`delete_sheet`/`move_sheet`/`hide_sheet`/`show_sheet`、`freeze`、`set_tab_color`。
     3. 编辑返回结果已带重算后的最新值，无需重复调用 `excel_read` 验证；若报 `revision` 冲突则重新 `excel_read` 后重试。

2. **从零新建 `.xlsx` 或批量脚本处理**
   - **`openpyxl`**：适合新建结构化报表、写公式、设置数字格式、颜色、边框、冻结窗格与原生图表。
   - **`pandas`**：适合大规模 CSV/Excel 数据清洗、聚合与统计分析；**注意**：修改已有工作簿时不要用 `df.to_excel()` 直接覆盖（会丢失原有公式、图表和样式），应将分析结果用 `openpyxl` 写回目标区域。

---

## 二、电子表格核心质量铁律

1. **公式优先，禁止硬编码计算结果**：
   - 所有合计、小计、均值、占比、增长率、差额、跨表汇总一律使用 Excel 公式（如 `=SUM(B2:B10)`、`=AVERAGE(C2:C10)`、`=IFERROR((C2-B2)/B2, 0)`），绝不在 Python 中算完填死数值。
   - 关键假设参数（税率、增长率、汇率等）单独放在假设区域并用绝对引用（如 `$B$2`）引用，方便用户改数自动联动。
2. **零公式错误**：
   - 确保交付的工作簿不含 `#REF!`、`#DIV/0!`、`#VALUE!`、`#N/A`、`#NAME?` 等公式错误；除法及查找类公式按需使用 `IFERROR` 兜底。
   - 修改已有工作簿时，必须使用 `load_workbook(path, data_only=False)`；**切勿用 `data_only=True` 打开后再保存**，否则所有公式会被永久覆盖为静态值。
3. **清晰专业排版**：
   - 若基于已有模板修改，严格保持原模板样式与格式约定；新建工作簿时遵循：
     - 表头行加粗、浅色底纹（如 `#1F4E79` 白字或 `#D9E1F2` 深字）、居中对齐并**冻结首行**（`ws.freeze_panes = 'A2'`）；
     - 合理设置列宽与行高，留出余量防止出现 `###` 或中文截断；
     - 规范数字格式：中文场景默认人民币 `¥#,##0.00`（大额单位在表头写明如“营收（万元）”）、百分比 `0.0%`、日期 `yyyy-mm-dd`、年份按文本或 `0` 显示避免出现 `2,026`；文本左对齐、数值右对齐；
     - 为数据区添加柔和细边框，汇总行上方加单细线/下方加双底线并加粗。

---

## 三、克制校验与交付红线（零弹窗）

1. **代码重开校验（必做）**：
   - 保存后用 `openpyxl.load_workbook(path, data_only=False)` 重新打开，核对工作表清单、关键行列范围、公式文本与引用是否正确（注意 Excel 行号从 1 开始、列字母无偏移）。
2. **公式重算与缓存值刷新（按环境优雅处理）**：
   - `openpyxl` 写入的公式默认不含缓存计算值：
     - 若工作簿已通过 LobsterAI 右侧编辑器（`excel_read` / `excel_edit`）打开或编辑，编辑器会自动重算。
     - 若本机存在可用的无头 LibreOffice，可运行 `python "<skill_dir>/recalc.py" <文件.xlsx> 30` 检查返回 JSON 中的 `status` 与 `error_summary`，发现错误及时修复。
     - 若 `recalc.py` 提示无可用 LibreOffice 或超时，**立即停止重试，不要寻找其他桌面软件**；核对公式逻辑无误后交付，并在回复中如实说明「公式语法与数据结构已校验，缓存值将在打开表格时自动计算」。
3. **绝对红线（严禁弹窗）**：
   - **严禁使用 `open -a`、`osascript`、直接运行 `.app` 可执行文件或启用 `computer-use` 来启动 Excel、WPS、Numbers 或图形界面 LibreOffice 打开或重算表格**。
4. **干净交付**：
   - 将最终 `.xlsx` 保存到用户工作目录，回复中用 `[表格名.xlsx](file:///绝对路径)` 给出可点击链接，并简述工作表结构与关键汇总指标。
