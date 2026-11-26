---
name: pptx
description: "创建、编辑与分析 PowerPoint 演示文稿（.pptx），支持高颜值 HTML 转 PPT、原生图表表格、右侧实时编辑与无头视觉自检。"
license: Proprietary. LICENSE.txt has complete terms
official: true
version: 2.0.0
---

# PPTX 演示文稿创建与编辑指南

请全程使用与用户输入一致的语言进行思考、过程说明与最终交付。参考脚本路径请基于本技能目录（`<skill_dir>`）解析。

## 一、任务路由（先选对路，避免绕远）

1. **编辑已有 `.pptx`（改文字、样式、坐标、增删/排序页面、改备注、选区"改这里"）**
   - **优先使用 LobsterAI 实时编辑工具 `ppt_read` + `ppt_edit`**（若工具未挂载，调用 `lobster_enable_tools({ capabilities: ["ppt"] })` 或已随本技能自动解锁）。
   - 修改会在右侧编辑器实时生效、保留原有主题/动画/未改动元素并自动保存：
     1. 先调 `ppt_read({ path, slides? })` 获取 `revision`、版式列表、各页 shape `id` 及用户当前 `selection`。
     2. 再调 `ppt_edit({ path, expectedRevision, edits })`，支持 `replace_text`、`set_text`、`set_table_cell`、`format_text`、`format_paragraph`、`set_bounds`、`add_text_box`、`delete_shape`、`add_slide`、`duplicate_slide`、`move_slide`、`delete_slide`、`set_notes`。
     3. 若报 `revision` 冲突则重新 `ppt_read` 后重试；编辑成功后的返回结果即已包含最新状态，无需重复 `ppt_read`。
   - 仅当涉及图片替换、复杂图表或只读文件等实时工具不支持的操作时，再按需局部查阅同目录 `ooxml.md` 并使用 `ooxml/scripts/unpack.py` / `pack.py`。

2. **从零新建高颜值 `.pptx`（无模板）**
   - **首选 `html2pptx` 工作流**：先写单页 HTML+CSS 幻灯片 → 无头 Playwright 截图快速自检 → 用 `<skill_dir>/scripts/html2pptx.js` 转为可编辑 PPTX，并用 `pptxgenjs` 填入原生图表与表格。
   - **直接复用本技能已内置的 Node 依赖**（`playwright`、`pptxgenjs`、`sharp` 已安装在 `<skill_dir>/node_modules`），无需全局安装 npm 包：在脚本中通过 `NODE_PATH="<skill_dir>/node_modules"` 运行，或直接 `require('<skill_dir>/scripts/html2pptx.js')`。
   - 极简纯数据/快速草稿也可用 `python-pptx` 直接生成（16:9 尺寸 `13.333 × 7.5` 英寸）。

3. **基于用户提供的模板 `.pptx` 改写**
   - 使用 `python-pptx` 或 `<skill_dir>/scripts/inventory.py`、`rearrange.py`、`replace.py` 复用模板页并替换占位文本。

4. **仅读取/提取 `.pptx` 内容**
   - 优先用 `ppt_read` 或 `python-pptx` 提取各页标题、正文、表格与备注。

---

## 二、视觉设计与中文排版原则

动笔前先确定整套配色与版式节奏，保持全套统一：

- **配色**：贴合主题选 1 组 3–4 色（主色 + 深浅背景色 + 1 个强调色），保证文字与背景高对比度；封面/收尾可用深色主调，正文页以清爽浅底或柔和灰底为主。
- **字体**：中文场景优先 `PingFang SC, Microsoft YaHei, Arial, sans-serif`；英文/数字清晰易读。主标题 28–36pt、页眉标题 20–24pt、卡片小标题 13–15pt、正文 11–13pt、核心 KPI 大字 32–48pt。
- **留白与密度**：每页只表达 1 个核心结论，保持至少 20–30% 留白；要点控制在 3–5 条精炼短句，**禁止大段文字塞满页面**。
- **结构多样且不堆砌**：按内容选用左右双栏（如 40%/60%）、2–4 卡片网格、时间轴、对比双表、指标大卡 + 原生图表等版式；**图表/表格页采用左右分栏或全页展示，绝不单列上下硬堆**。

---

## 三、`html2pptx` 关键硬规则（避坑速查）

写 HTML 幻灯片时必须遵守以下规则（高级 PptxGenJS 图表/表格参数可按需查阅 `<skill_dir>/html2pptx.md`）：

1. **固定画布**：16:9 使用 `body { width: 720pt; height: 405pt; margin: 0; padding: 0; display: flex; flex-direction: column; overflow: hidden; }`（4:3 为 `720pt × 540pt`）。
2. **文字必须包裹在文本标签内**：所有文字都必须放在 `<p>`、`<h1>`–`<h6>`、`<ul>`、`<ol>` 中；直接写在 `<div>` 或 `<span>` 里的裸文字会被静默丢弃！
3. **规范列表**：用 `<ul>`/`<ol>`，禁止手写 `•` / `-` 符号。
4. **样式边界**：背景色、边框、圆角（`border-radius`）、外阴影（`box-shadow`）**只能写在 `<div>` 上**，绝不能写在 `<p>`、`<h1>`–`<h6>`、`<ul>` 上；`<span>` 仅支持 `font-weight`、`font-style`、`text-decoration`、`color`，禁止加 `margin`/`padding`。
5. **禁止 CSS 渐变**：`linear-gradient`/`radial-gradient` 无法导入 PPT；如需渐变背景或矢量图标，先用 `sharp` 将 SVG 栅格化为 PNG 后通过 `<img>` 引入。
6. **原生图表/表格占位**：在 HTML 中放 `<div class="placeholder" style="width:...; height:...;"></div>`，`html2pptx()` 返回 `{ slide, placeholders }` 后，用 `pptxgenjs` 在 `placeholders[i]` 坐标上调用 `slide.addChart(...)` / `slide.addTable(...)`。注意 **PptxGenJS 颜色值不带 `#`**（如 `'1E3A8A'`）。
7. **防底部裁切**：正文距离底部留出至少 `24–36pt` 安全边距。

---

## 四、无头视觉自检与交付红线（严格控制步数，零弹窗）

1. **HTML 阶段无头截图自检（首选，1–2 秒出图，零弹窗）**：
   ```bash
   node "<skill_dir>/scripts/preview_html.js" <html目录> --out <临时目录>/slides-preview.jpg
   ```
   - 脚本会自动检测每页是否溢出（`overflows` 字段）并拼出带编号的缩略图网格。
   - 用 `read_image` 检查网格图（重点看有无文字截断、重叠、大片空白或对比度不足）。
   - **克制返工**：如有问题，一次性集中修改相关 HTML 并重新运行校验，**视觉微调最多 1–2 轮**，不要逐页反复微调几十步。
2. **构建并结构校验 `.pptx`**：
   - 运行构建脚本输出最终 `.pptx`（确保 `html2pptx()` 零报错）。
   - 用 `ppt_read` 或 Python 标准库 `zipfile` 快速复核总页数（`ppt/slides/slide*.xml`）与关键标题/图表是否存在即可。
3. **绝对红线（严禁弹窗）**：
   - **严禁使用 `osascript`、`open -a`、`computer-use` 或任何命令启动 Keynote、PowerPoint、WPS 或图形界面 LibreOffice 来预览或导出 PDF**。
   - 仅当用户明确要求导出 PDF 且本机存在可用的 `soffice --headless` 时，才可调用 `soffice --headless --convert-to pdf`；否则直接跳过 PDF 导出，只交付 `.pptx`。
4. **干净交付**：
   - 将最终 `.pptx` 放在用户工作目录的清晰路径下，清理多余临时文件（或留在临时目录，不向用户交付中间脚本与过程图）。
   - 回复中用 `[演示文稿名称.pptx](file:///绝对路径)` 给出可点击链接，并简述总页数与核心结构。
