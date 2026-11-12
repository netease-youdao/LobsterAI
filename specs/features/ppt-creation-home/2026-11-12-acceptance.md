# PPT 首页入口测试环境验收

2026-11-12 完成本轮入口验收。额外回归课件的文字缺失已定位为生成文件的内边距单位错误，并通过实际客户端修复；代码未提交，prod 未变更。

[Confluence 完整报告](https://confluence.inner.youdao.com/pages/viewpage.action?pageId=445528269) 位于原预研目录下，保留数据口径、8 个示例选择依据、全部真实成品/模板链接、完整 SHA-256、13 张流程截图、积分记录和待确定项。

## 实施与配置

- 分支 `feat/ppt-home-research`，隔离工作区 `D:/github/LobsterAI-ppt-home-research`；基线 `release/2026.11.9` 的 `725cc43e1b116ee033921a0eb40cdc04664178bd`，02:17 再次核实远端一致。
- 保留后续 #3046、#3048–#3051 的 UI 调整。首页仍默认图片创作，图片收起偏好保留；PPT 使用完整比例预览、4/3/2 列与最多两行，完整目录可见全部 8 个示例。
- 3 个直接试做、5 个引导定制；支持具体提示词回填、原草稿恢复、上传材料、真实模板、大纲确认、严格限定修改页。点击示例不会自动发送，直接试做由用户回车启动。
- 全部 8 个展示成品与 3 套模板由专用测试客户端生成并经逐页检查、上传、下载回读和 SHA-256 验证。未使用宿主脚本代替客户端制作或修复 PPT。
- Overmind 项目 475，仅发布 test 的 `ppt-creation-examples`，配置 ID `13244`，版本 `2026-11-12.2`；其他 12 个 test 键未改，prod/oversea-test/oversea-prod 无新增 PPT 键。公开接口完整回读一致。
- 动态刷新在同一 Electron/renderer 进程内完成：02:09:13 发布，02:15:25 前定时刷新生效，重新打开预览已显示新版本；没有依赖重启。版本变更会关闭旧预览/编辑弹窗，未填入草稿的弹窗编辑不保留。

## 验证结果

- 变更 TypeScript 文件 ESLint 零错误/警告；10 个文件 404 项 Vitest 通过；renderer/main TypeScript 检查通过；main 与四套 preload 单次构建通过。最后代码修改后的这些检查已完成，后续只更新验收文档与独立验收脚本，没有重复执行无关全仓测试。
- 实际 Electron CDP 完成 15 项入口检查；覆盖图片默认与收起记忆、响应式列数、全部示例、三套模板、真实材料下载和 SHA 校验、自定义内容、Plan 草稿、草稿恢复、严格原稿守卫、预览翻页、test 发布、动态刷新和实际回车任务。
- 严格改稿最终只改 `slide2.xml`、`slide6.xml`、`chart4.xml`。其他 8 页的 XML、备注、关系和渲染 PNG 不变，共享主题/母版不变，图表原始数值不变。
- 展示成品的包结构、几何与逐页内容检查完成；原生图表及嵌入工作簿逐项核对。行业资料采用 IEA 2026 报告，2025 实际值与 2026 预测分开。

## 真实回车任务与质量边界

新增回归会话 `5120f249-7777-4219-be0f-f4749edbcbc7` 由首页水循环卡片和一次实际 Enter 启动。首轮单条用户消息自动完成 8 页 PPTX、讲稿和 PDF，84 次模型调用、187.021180 明细积分、约 19 分 38 秒。

首轮独立检查发现 7 条指向不存在母版的声明，以及第 4/5 页科学表述问题。前三条客户端修订只改变包声明及第 4/5 页和对应备注，其他 6 页 PNG 字节不变。随后原生预览暴露文本框内边距单位错误，由第 4 条客户端修订指令修复。该会话最终合计 130 次调用、348.508830 明细积分。最终 SHA-256 为 `1b86af5527cda86c4295d3cff4949965058852e852b419748e946c4733c8f890`。

这份额外回归产物不替换首页已经精选验收的水循环示例。入口流程通过不能解释为首次产物质量合格，也不支持承诺一次成功率。

文字缺失根因已经确认：源脚本 `chip()` / `node()` 的 `inset: 2` 以英寸计，误把 2pt 写成 2 英寸。实际客户端只修正第 1/3/5/6/8 页、25 个文本框的 100 个内边距属性（1828800 → 25400 EMU），并同步修正源脚本为 `PT(2)`，没有整包重建。其余 50 个 ZIP 部件字节不变，8 页文字和备注及其他 XML 内容不变。此前暂记为原生编辑器兼容性的判断已纠正。

最终包结构、几何和全部 8 页视觉检查完成；原生 Electron 逐页截图证明全部 25 个受影响文字范围位于各自文本框内。LibreOffice 前后 PNG 哈希仅第 6 页改变，其他 7 页一致；变化页已人工复核。首页 8 个精选成品、3 套模板及原稿材料没有同类异常，所有 SHA-256 未改变。本次未修改 Office 编辑器代码。

原生预览仍会简化第 6 页太阳/云朵等部分预设形状，不能据此宣称全面 PowerPoint 保真；首页使用验收后的完整 PNG。未执行原生 PowerPoint 应用验证。

隔离开发环境首次 PDF 预览因链接依赖路径限制返回 worker 403；仅修改临时验收启动脚本，放行确切 `pdfjs-dist` 依赖路径后，资源回读 200，客户端完整显示 8 页。未修改产品 Vite 配置。此前同进程动态刷新证据不依赖这次 renderer 重启。

## 账本与证据位置

专用 test 账号 `23204`，测试额度发放记录 `986`，20,000 测试积分；没有真实支付，也没有重复注册或发放。

最终快照北京时间 10:15:54：共 1,038 次调用，明细积分 `6923.135972`；先前数据库记录免费额度已用 `300`，最终测试加油包已用 `6623.37`。本次内边距修订新增 15 次调用、67.150190 明细积分。调用明细与钱包各自保留原精度，包含失败、重试、模板和修订，不作为单份成品价格。

最终直接数据库连接超时，改用专用账号已登录的正式只读 `usage-conversations` 接口，按固定快照分页保留新增会话全部调用。此前 8 个会话的调用数、精确积分与 02:04 数据库快照完全一致。

本地证据根目录为 `D:/tmp/lobster-ppt-entry-20261111`：

- `evidence/ui-acceptance-verdict.json`：15 项检查、已解决问题及验证范围。
- `evidence/approved/`、`evidence/uploads.json`：8 个展示成品、3 套模板、上传及回读哈希。
- `evidence/catalog-test-20261112.json`、`overmind-public-verified.json`、`dynamic-refresh-verdict.json`：最终目录、环境范围与刷新记录。
- `evidence/usage-summary.json`、`usage-api-current.json`、`test-usage.json`：最终汇总、API 分页明细、较早数据库快照。
- `evidence/ui-smoke-final-20261112.json`、`ui-smoke-repaired-final-20261112.json`、`ui-smoke-insets-final.json`：首次完成与各轮修订后的完整会话。
- `evidence/qa/ui-smoke-water-final/`、`ui-smoke-water-repaired-final/`、`ui-smoke-water-insets-final/`：初稿问题、修复前后检查、逐页图像及修改范围比对。
- `evidence/insets-repair-verdict.json`、`native-insets-preview-verdict.json`、`text-insets-audit.json`：最小修改证明、25 个原生文本框与全部展示材料审计。
- `evidence/confluence-acceptance-published.json`、`confluence-attachments-verified.json`：报告正文与 13 张截图读回验证。

生产发布、灰度人群、模型选择、积分提示、自动质量门禁及更广泛的原生预览兼容性改进留待后续决定。本轮不提交代码、不创建 PR、不发布 prod。

## 收尾

02:47 确认全部 9 个测试会话 completed 后，关闭本任务 BrowserAct 会话，并仅停止独立 Electron/renderer 的 15 个所属进程。5277/19561 无监听，本任务进程剩余 0；可用内存回升至 4.50 GB。已通过 Codex 自动化工具删除续跑任务 `ppt`，不会继续每两小时启动。测试账号、会话、额度账本、成品和证据均保留。

10:26 完成最后的内边距修复与复验，Confluence 更新到版本 3；正文、链接和 13 张截图均已回读，附件 SHA-256 与本地一致，页面图片全部正常加载。9 个会话再次确认 completed 后，关闭本次 BrowserAct 会话，并仅停止所属 Electron/renderer 的 12 个进程；本任务根进程及 5277/19561 监听均为 0。续跑任务 `ppt` 再次确认不存在。最新收尾记录为 `evidence/completion-insets-cleanup.json`，历史记录仍保留。
