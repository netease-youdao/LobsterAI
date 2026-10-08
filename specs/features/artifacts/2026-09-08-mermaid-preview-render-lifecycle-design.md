# Mermaid 预览异步渲染生命周期修复

## 1. 问题与证据

任务侧栏打开 `agent-architecture.mmd` 时显示 `Cannot read properties of null (reading 'firstChild')`。当前客户端声明并安装的 Mermaid 是 10.9.5；产物工作目录中的 8.14.0 不参与客户端预览。

使用原始文件进行隔离浏览器验证：

- Mermaid 独立解析、渲染成功，将首行 `graph TB` 换为 `flowchart TB` 也成功，排除当前文件的该语法兼容问题。
- 现有组件单实例普通挂载成功，开发态 StrictMode 首次挂载复现同样的 `firstChild` 错误。
- 同产物 ID 的两份预览也可复现；不同 ID 的对照组成功。这是隔离诊断场景，不代表正常界面一定同时打开两份预览。

根因是每轮 effect 从同一个 artifact ID 推导 Mermaid DOM ID，并在开始、effect cleanup、finally 阶段按该 ID 全局删除 DOM。Mermaid 公共 API 虽有串行队列，但旧调用的外部清理仍可在新调用的异步阶段删除其临时节点。被取消的旧 effect 在 `await parse` 之后也未检查取消状态，会继续进入渲染队列。

## 2. 目标与非目标

目标：消除重复挂载、内容更新、关闭重开及并发预览时的节点误删；旧任务不得覆盖当前图表或错误状态；保留解析错误提示和缩放操作。

仅修改共享的 Renderer Mermaid 预览组件及其生命周期辅助模块，因此任务侧栏和文件库完整预览均受益。

不修改 Main/IPC、文件读取、数据库、OpenClaw、产物排序、网格折叠、HTML 静态缩略图、分享/导出链路或 Mermaid 版本。保留 `securityLevel: 'strict'`，不以关闭 StrictMode、放宽安全级别或改写原始 `.mmd` 内容规避问题。

## 3. 生命周期设计

### 3.1 每轮调用独立身份和所有权

- 每次实际渲染生成 `mermaid-${crypto.randomUUID()}`，不使用经过标点过滤的 artifact ID。
- 每轮只持有一个自己创建的临时容器，保留对该 DOM 对象的引用。
- 不再使用 `document.getElementById(id/did/iid)` 清理节点，避免删除其他任务的临时 DOM 或已经展示的 SVG。
- 不增加第二套全局渲染队列/锁，继续使用 Mermaid 自带队列。

### 3.2 解析、取消和清理

| 阶段 | 行为 | 收到取消时 |
| --- | --- | --- |
| 解析中 | 先 `parse(source)`，不创建临时 DOM，避免非法语法生成全局错误 SVG | 标记取消；解析完成后不创建容器、不调用 render |
| 渲染中（含已排队） | 在连接到 document 的独占容器中调用 render | 只标记取消，不能提前移除 Mermaid 仍可能使用的容器 |
| 成功 | 仅未取消的调用提交 SVG，并清除错误 | 旧结果丢弃 |
| 失败 | 仅未取消的调用清空 SVG、展示错误；解析和渲染异常均被接住 | 旧错误丢弃，不产生未处理的 API Promise rejection |
| 结束 | finally 移除本轮容器 | 即使取消也执行；清理不影响其他调用 |

取消表示失去后续渲染/结果提交资格，不宣称能真正中止已经开始的 Mermaid 内部计算。取消方法幂等；本次不新增硬超时，也不在超时点销毁仍被使用的 DOM。

### 3.3 保留可测量布局与错误恢复

- 临时容器继续挂在 `document.body`，使用 `visibility:hidden`、绝对定位和禁用指针事件；不能改为 `display:none` 或离线 DOM，否则布局测量及内部选择器可能失效。
- 预览滚动容器在成功/错误状态间保持挂载，错误信息仅替换内部内容。这保证错误恢复后 Ctrl/Cmd + 滚轮缩放的监听仍有效。
- 错误时隐藏缩放工具；成功恢复后保留原有缩放按钮、缩放范围与重置行为。
- 错误区域使用 `role=alert`；错误标题、非 Error/空错误的兜底文案提供中英文，具体解析错误保留 Mermaid 原始信息。

## 4. 模块与接口

- `src/renderer/components/artifacts/renderers/mermaidRenderLifecycle.ts`：导出 `startMermaidRender({ source, api, createContainer, onSuccess, onError })`，返回 `{ cancel, done }`。负责唯一 ID、异步取消检查、当前结果回调和 finally 资源清理；不导入 React/Mermaid 运行时，便于确定性测试。
- `MermaidRenderer.tsx`：保留 Mermaid 初始化、隐藏容器创建及视图/缩放状态；effect 启动任务并返回 `task.cancel`。
- `mermaidRenderLifecycle.test.ts`：使用可控 Promise 和独立容器 stub 测试生命周期，不以 DOM stub 代替真实浏览器验证。
- `src/renderer/services/i18n.ts`：增加 `artifactMermaidRenderError`、`artifactMermaidRenderFailed` 双语文案。

## 5. 验收标准

- 同一个原始 `.mmd` 在普通挂载、StrictMode 和同产物多实例下均正确显示，无 `firstChild/appendChild` 空节点错误。
- 解析尚未完成就取消，不调用 render；渲染中取消，不提前删除容器，结束后不提交旧成功或旧错误。
- 旧任务晚于新任务结束也不能清理新任务的 DOM；不同实例/渲染轮次的 ID 均不碰撞。
- 无效语法显示明确错误且不向页面泄漏错误 SVG；改为有效内容后可恢复显示，按钮及 Ctrl/Cmd + 滚轮缩放正常。
- 连续内容更新只呈现最新结果；关闭重开不遗留临时容器或未处理异常。
- TypeScript、触及文件 ESLint、相关 Vitest 和构建通过；使用原始文件进行隔离浏览器回归，不修改用户文件。

## 6. 实施验证

2026-09-08 验证结果：

- 相关 Vitest 共 42 个文件、435 项测试通过，包含新增的 14 项异步生命周期回归测试。
- 4 个触及的 TypeScript/TSX 文件通过 CI 口径 ESLint，零警告；`git diff --check` 通过。
- `npm run build` 通过；构建仍提示已有的 Browserslist、CJS、依赖 eval 和混合静态/动态导入警告。
- 使用原始 `agent-architecture.mmd` 和实际组件，在隔离 Chrome 的开发/生产模式下通过单实例、StrictMode、同产物双实例验证；图表可见且无临时容器残留。开发模式实际执行 StrictMode effect 重放，生产模式不重放。
- 同一浏览器回归中，无效语法可显示错误且不泄漏错误 SVG，恢复有效内容后滚轮与按钮缩放正常；16 次快速更新只呈现最新结果，10 次关闭重开无渲染错误。
- 使用仓库 Electron 43.5.0 / Chromium 150 的独立隐藏窗口，在 `file:` 页面、sandbox/contextIsolation 开启且 nodeIntegration 关闭的环境下通过原文件 StrictMode 渲染与卸载验证；`crypto.randomUUID` 可用，临时容器残留为 0。

测试使用临时目录与独立配置，不修改原始文件、不连接真实会话数据库、不重启用户客户端。HTML 静态缩略图行为保持不变。上述组件级浏览器/Electron 验证不等同于完整客户端与 Windows/Linux 人工验收，完整界面仍需用户重新打开 `.mmd` 确认。
