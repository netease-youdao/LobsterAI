---
name: docx
description: "创建、编辑与分析 Word 文档（.docx），支持右侧实时编辑、规范中文排版、批量生成与修订批注。"
license: Proprietary. LICENSE.txt has complete terms
official: true
version: 2.0.0
---

# DOCX 文档创建与编辑指南

请全程使用与用户输入一致的语言进行思考、过程说明与最终交付。参考手册路径请基于本技能目录（`<skill_dir>`）解析。

## 一、任务路由（按场景选最简方案）

1. **编辑已有 `.docx`（改文字、样式、段落、插表格、选区"修改这里"）**
   - **优先使用 LobsterAI 实时编辑工具 `word_read` + `word_edit`**（若工具未挂载，调用 `lobster_enable_tools({ capabilities: ["word"] })` 或已随本技能自动解锁）。
   - 修改会在右侧 Word 编辑器实时显示、保留未动部分的原格式并自动保存：
     1. 先调 `word_read({ path })` 获取 `revision`、各段落 `id`/`style`/`text`（表格单元格含 `table`/`row`/`cell`）及用户当前 `selection`。
     2. 再调 `word_edit({ path, expectedRevision, edits })`，支持 `replace_text`（保留局部 run 样式）、`set_text`、`insert_paragraph`（`anchor` 为段落 `id`/`"start"`/`"end"`，`\n` 分段，可设 `style`）、`delete_paragraph`、`format_text`、`format_paragraph`、`insert_table`。
     3. 若报 `revision` 冲突则重新 `word_read` 后重试；编辑成功返回的结果即最新内容，无需再次 `word_read`。

2. **从零新建 `.docx` 文档**
   - **优先选 `python-docx`**（轻量快速、几乎零依赖折腾，适合绝大多数报告、方案、纪要、合同与含表格/图片的正式文档）；若需复杂页眉页脚、多级目录或已有 Node 流水线，也可选用 **`docx`（docx-js）**（需查具体 API 时再按需局部查阅 `<skill_dir>/docx-js.md`，不要整篇盲读）。
   - 写完文档脚本后一次性生成，避免反复试探环境几十步。

3. **修订模式（Tracked Changes / 批注 / 法律或他人文档审阅）**
   - 仅在用户明确要求保留修订痕迹（红线修改）或添加批注时，走 OOXML 修订流程：按需局部查阅 `<skill_dir>/ooxml.md` 的 "Document Library" 与 "Tracked Change Patterns"，使用 `ooxml/scripts/unpack.py`、`scripts/document.py`、`ooxml/scripts/pack.py`。
   - 修订原则：只标记真正改动的最短词组（保留未改动文字的原始 `<w:r>` 与 `rsid`），不要整段删了重写。

4. **读取/提取 `.docx` 文本**
   - 优先用 `word_read` 或 `python-docx` 读取段落与表格；若需查看修订痕迹可用 `pandoc --track-changes=all file.docx -o out.md`。

---

## 二、中文专业排版与核心避坑

1. **页面与字体**：
   - 中文文档默认 **A4 纸张**（210mm × 297mm），页边距 2.54cm（1 英寸）；统一配色（如深蓝主色 `#1F4E79` + 浅灰表头/引用底色 `#F2F5F9` + 深灰正文 `#222222`）。
   - **必须同时指定西文与东亚字体（`w:eastAsia`）**：中文推荐 `PingFang SC` / `Microsoft YaHei`（或正式公文用 `SimSun` / `FangSong`），西文数字用 `Arial` / `Calibri`，避免出现方框乱码或中英字体错位。
2. **结构与分页**：
   - 用规范标题层级（`Heading 1` / `Heading 2` / `Heading 3`）和段前/段后间距（如段后 6pt、行距 1.3–1.5 倍），不要用连续空行硬撑间距。
   - **分页符避坑**：
     - `python-docx`：使用 `document.add_page_break()` 或段落的 `paragraph_format.page_break_before = True`；
     - `docx-js`：`PageBreak` **必须放在 `Paragraph` 的 `children` 内**，绝不能作为顶层元素，否则 Word 无法打开。
   - **目录（TOC）注意**：Word 动态域代码目录首次打开前默认不会自动展开页码；如需用户一打开就看到完整结构，推荐在封面后直接生成排版整洁的静态「内容导览 / 目录概览」块（或清晰告知用户可在 Word 中右键更新目录域）。
3. **表格与列表避坑**：
   - `docx-js` 表格底纹**一律用 `ShadingType.CLEAR`**（禁止 `ShadingType.SOLID`，会渲染成全黑底！）；必须同时提供 `columnWidths` 与各单元格宽度，每个单元格至少包含一个 `Paragraph`。
   - `python-docx` 表格显式设置列宽、表头加粗+浅色填充、清晰细边框、单元格内边距与跨页表头重复（`w:tblHeader`）。
   - 列表使用标准编号/项目符号样式；段落中不要滥用 `\n` 强制换行，每条独立成段。
   - `docx-js` 插入 `ImageRun` 时必须显式传入 `type`（`"png"` / `"jpg"` 等）。

---

## 三、克制校验与交付红线（零弹窗、高效率）

1. **代码重开校验即完成常规验收**：
   - 保存 `.docx` 后，用 `python-docx`（或 `word_read`）重新打开，核对：① 文件可正常解析；② 章节标题数量与结构完整；③ 表格行列数与核心数据正确；④ 无意外空白或占位符残留。
   - **新建文档与常规编辑只要内容和结构校验通过即可直接交付，无需强制转 PDF 或图片**。
2. **视觉校验仅作可选增强，绝不强求**：
   - 仅当用户明确要求导出 PDF / 视觉版面图片检查，且本机存在**可用**的 `soffice --headless` + `pdftoppm` 时，才执行：
     ```bash
     soffice --headless --convert-to pdf document.docx && pdftoppm -jpeg -r 130 document.pdf page
     ```
   - 若 `soffice --headless` 不可用或执行失败，**立即停止视觉转图**，在最终回复中如实注明「内容与结构校验已通过；本机未配置无头渲染环境，未进行页面转图」即可。
3. **绝对红线（严禁弹窗与乱用键鼠）**：
   - **严禁使用 `open -a`、`osascript`、直接运行 `.app` 可执行文件或启用 `computer-use` 来打开 WPS、Microsoft Word、Pages 或图形界面 LibreOffice 查看/检查文档**。
4. **干净交付**：
   - 最终 `.docx` 输出至用户工作目录，不留下杂乱中间脚本。
   - 回复中用 `[文档名.docx](file:///绝对路径)` 给出可点击链接，简明总结章节结构与核心要点。
