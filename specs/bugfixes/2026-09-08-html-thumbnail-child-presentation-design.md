# HTML 网格缩略图白屏修复

## 问题与证据

`dayan-shenjun/index.html` 的网格缩略图全白，完整预览正常。原文件的背景、导航、标题均存在于 HTML/内联 CSS 中，不依赖脚本生成；标题等元素存在 CSS 入场动画。

使用原文件和当前生成器的隔离 Electron 诊断中，6 次冷窗口首次截图有 2 次全白，同一窗口约 100ms 后重新截图即可看到深色页面，随后动画结束显示完整标题。实际磁盘缓存也存在该文件的全白 PNG。

原链路只等 iframe load 和父文档布局，不能证明子 frame 已提交画面。HTML 没有子帧呈现校验，白 PNG 可作为成功结果写入缓存；路径、mtime、大小不变时继续命中。完整预览使用另一条本地网页加载链路，不受缩略图缓存影响。

## 范围与安全边界

- 只修改客户端 HTML/HTM 缩略图呈现、缓存及原生降级保护；不改变任务排序、网格折叠、完整预览、用户文件、数据库或服务端。
- 保留 DOMPurify 整页净化，删除脚本、嵌套 frame、外部 link 等标签；iframe 继续使用空 sandbox，不新增 allow-scripts/allow-same-origin。
- 不上传文件，不为截图运行页面脚本，不以重新启用脚本修复动态 HTML。之前 Mermaid HTML 静态预览的能力边界不变。

## 子帧呈现合同

| 区域 | 输出坐标 | 内容 |
| --- | --- | --- |
| 缩略图 | y=0..269 | 最终 480×270 PNG |
| 子帧提交戳 | y=270..271 | iframe 内绘制，颜色由本轮代次派生 |
| 父文档提交戳 | y=272..273 | 现有父页面代次戳，向下移动 2px |

尺寸计算使用请求尺寸与共享常量，不硬编码上述默认值。iframe 保留 2 倍排版、0.5 倍缩放，子戳在源文档为 4px 高；总隐藏窗口增加 2px。这会使子页面视口高度比此前增加 4 CSS px，需验证 vh 首屏布局，最终输出尺寸不变。

子戳使用净化文档根元素的专属 `html[data-library-thumbnail-stamp]::after`，固定定位、独立颜色及样式重置，避免 body 的 margin、transform、filter、opacity 或 clip-path 改变标记位置/颜色。不把标记作为 body 子元素，也不为标记执行脚本。

该伪元素仅在缩略图副本中保留使用，可能替代原页面的根元素 ::after；对 html 根元素自身的变换/透明度等无法可靠校验的特殊样式，按现有超时与降级处理，不擅自重写页面根样式。这是静态缩略图能力边界，不承诺任意网页像素级一致。

主进程必须在**同一张 NativeImage** 中同时验证当前父代次戳与子代次戳，随后直接裁剪这张图。父戳单独有效、子戳缺失、旧代次、尺寸错误均不能成功。子戳颜色与同代父戳不同，支持高 DPI 像素采样。

- Windows：复用 frame subscription，收到不匹配帧继续等待，3 秒上限，成功/失败释放订阅和计时器。
- macOS/Linux：抓取含双戳区域，未通过则间隔最多 50ms 再次采样；整个呈现阶段上限 3 秒，单次 capture 也受剩余总时间限制。
- 成功图裁掉两条标记带；纯白/纯色内容只要双戳有效，也允许成功，不用颜色均匀度代替呈现证明。
- 失败复用已有失败码、最多两次 Renderer 尝试、原生降级、前端有界重试；不增加第三套队列，不无限等待或重试。

## CSS 动画快照

净化后用独立 CSSStyleSheet 解析内联样式，不把源样式装到可信父页面。仅收集能匹配源文档元素的样式声明和元素内联 animation；before/after 匹配其所属元素。

有限动画按 `delay + duration × iterationCount` 估计快照等待，使用最大值而非累加，增加 50ms 余量，总计不超过 3 秒；零时长但正延迟的入场也需等待。无限动画不参与等待，静态/未匹配动画页面不统一等待数秒。不得全局设置 animation:none，以免将初始 opacity:0 固定为隐藏。

这是有界、尽力而为的静态样式估计，不是浏览器实际运行动画完成事件：跨规则级联、未解析的 var/calc 时长、动态状态和媒体条件不完整求值。未知时长跳过；不等待脚本触发的 reveal，不承诺图片、字体及所有动画都完成。子帧戳只证明已呈现，不等同于这些资源全部就绪。

iframe load/error 监听必须先于 srcdoc 设置/挂载，load 上限 3 秒；load 完成后进入有界动画等待，完成/失败均清理监听和计时器。主进程原有 Renderer 总超时继续生效。

## 缓存与降级

- 主进程 HTML/HTM 使用 `html-child-presentation-stamp-v1` 独立版本，前端内存 key 同步采用 HTML 专用版本。旧 HTML 白 PNG 自然不命中，不批量删除缓存。
- 栅格、PDF、DOCX、PPTX 等现有策略版本不变；沿用路径、mtime、大小变更失效以及 LRU。
- 正常 Renderer 校验成功的纯色 HTML 保留；仅在原生 fallback 中，缺乏子帧证明的纯白、纯色或透明输出按可疑空白失败，不再缓存为成功结果。最终显示现有类型封面与重试入口。
- 保持原 Windows PPTX 的源内容感知空白规则不变。

## 模块

- `src/shared/library/htmlThumbnail.ts`：HTML 扩展名判断、布局/等待上限、子戳颜色。
- `src/renderer/libraryThumbnail/htmlThumbnailRenderer.ts`：净化、子戳、iframe 生命周期及样式时序采集；由已有 main 入口调用。
- `src/renderer/libraryThumbnail/htmlThumbnailAnimation.ts`：可独立测试的动画等待估算。
- `src/main/libs/libraryThumbnailPresentation.ts`：单图双戳校验；其他格式保持原单戳行为。
- `src/main/libs/libraryThumbnailRenderer.ts`：按格式调整窗口尺寸，平台截图/订阅，通过校验后裁剪。
- 缓存 service/client key 和 native validation helper：仅改变 HTML 策略；`src/main/main.ts` 保留最小接入改动。

## 验证

- 相关 54 个 Vitest 文件、616 项测试通过，包含原有 Mermaid 预览回归；新增覆盖双戳缺失/旧代次、合法纯白、高 DPI、截图等待上限、同图裁剪、缓存失效、原生降级、动画时序。
- 触及 TypeScript 文件按 CI ESLint 口径通过，`git diff --check` 通过。
- `npm run build` 与 `tsc --noEmit -p electron-tsconfig.json` 通过；保留已有 Browserslist、Vite CJS、依赖 eval 和混合动态/静态导入警告。
- 最终隔离 Electron 43.5.0（macOS、file:、实际构建的缩略图页面）中，原文件 6 次冷窗口均生成正确的 480×270 缩略图，约 2.8～3.0 秒；已检查标题及内容可见，无标记泄漏。
- 合法纯白、纯黑、普通静态页、无限动画、body transform/opacity/clip-path、未匹配动画、0s 时长但正延迟的入场、脚本净化样例全部通过；6 次黑白文件交替也无串图。普通静态页与无限动画约 80～200ms（含部分平台调度波动），0s 延迟入场约 1.1 秒。空 sandbox 与净化后无 script 均被断言。
- 不重启用户实际客户端，不访问真实会话数据库；Windows/Linux 实机 UI 与完整客户端验收仍需补充。测试临时文件和截图保留在项目外，不修改原 HTML 或真实缓存。
