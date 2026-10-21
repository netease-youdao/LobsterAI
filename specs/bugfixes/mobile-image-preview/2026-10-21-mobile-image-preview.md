# 手机上传图片在桌面放大预览不清晰

日期：2026-10-21

## 问题与根因

手机上传图片后，桌面消息中的缩略图可以显示，但点击进入全屏预览时仍只显示很小的图片，文字无法辨认。

当前链路中，服务端分片上传与下载保留上传字节，桌面 `InputPreparationService` 校验 SHA256 并保存原文件。`RemoteImageDecoder` 另生成长边不超过 256px、JPEG quality 0.7 的缩略图，供消息列表持久化和展示；模型输入使用原尺寸图片或原尺寸 PNG 转码结果。

消息 `imageAttachmentPreviews` 已保留指向原文件的 `localPath`。问题在 Renderer：`UserMessageItem` 打开 `ImagePreviewModal` 时只传缩略图 Data URL，弹窗直接把该 URL 作为大图来源，没有读取原文件。

## 修复行为

1. 消息列表继续使用已有缩略图，不在历史加载或列表渲染时批量读取原图。
2. `UserMessageItem` 点击图片时，把已有 `localPath` 一并传给 `ImagePreviewModal`。
3. 弹窗先展示已有缩略图，再通过 `window.electron.dialog.readFileAsDataUrl(localPath)` 按需读取原文件；成功后使用返回的完整 Data URL，沿用现有适应窗口的样式。
4. 原文件不存在、读取被拒绝、IPC 抛错或浏览器解码失败时，保留/恢复缩略图，不使历史图片变成空白。
5. 切换图片、关闭或卸载时忽略旧请求结果。已加载原图仅属于当前打开的图片；切换后的首帧也不能显示上一张原图。
6. 关闭弹窗后释放组件持有的原图状态，不向消息 metadata、Redux 或数据库写回完整原图。

## 代码范围与兼容性

| 文件 | 修改 |
|---|---|
| `src/renderer/components/cowork/UserMessageItem.tsx` | 点击附件时传递 `localPath` |
| `src/renderer/components/cowork/ImagePreviewModal.tsx` | 可选路径、按需读取、竞态隔离、错误回退 |
| `src/renderer/components/cowork/ImagePreviewModal.test.ts` | 原图来源与异步行为回归 |

仅修改 LobsterAI 桌面客户端。复用现有 IPC 及其大小上限、文件访问策略与账号变化复检，不增加权限绕过；不修改上传、下载、转码、缩略图生成或模型输入。

`ImagePreviewSource.localPath` 为可选属性；无路径的内联图片、旧版消息及其他弹窗调用方继续显示传入的 `src`。已有历史消息只要保留 `localPath` 且本地原文件仍存在，升级桌面后即可读取原图。原文件已经被清理或上传前已被手机压缩的图片，不能由此恢复丢失的细节。

无服务端 API、手机协议或数据库变更，无 MySQL 版本要求变化；无需同步升级服务端、Portal、Admin 或手机 App。

## 验收

| 场景 | 预期 |
|---|---|
| 新上传大图及保留原文件的历史图片 | 消息列表显示缩略图；点击后加载原图，浏览器自然尺寸与原文件一致 |
| 未打开图片 | 不调用原图读取 IPC |
| 无 `localPath` 的旧消息/内联图片 | 沿用已有图片来源，不调用原图读取 IPC |
| 原文件缺失、权限拒绝或 IPC 失败 | 保留缩略图，弹窗仍可关闭 |
| 读取成功但图片不能解码 | 回退缩略图，不循环读取 |
| 快速切图、乱序返回 | 旧图片结果不能覆盖新图片 |
| 关闭并重开同一图片 | 上一次打开的请求不能覆盖本次请求 |

自动化与静态检查记录：

- `npm test -- src/renderer/components/cowork/ImagePreviewModal.test.ts`：9 项通过。
- `npm test -- src/shared/cowork/imageAttachments.test.ts src/main/remote/inputPreparationService.test.ts src/main/remote/remoteImageDecoder.test.ts`：60 项通过。
- 对上述 3 个变更 TypeScript 文件执行严格 ESLint：通过。
- `npx tsc --noEmit`：通过。
- 未执行服务端测试；没有服务端变更。

回归有效性：使用 `/tmp/image-preview-baseline.vitest.config.mjs` 的只读加载插件对旧版 `ImagePreviewModal` 执行同一测试，9 项中 5 项失败、4 项通过，确认测试能捕获旧版始终使用缩略图的问题；没有覆盖工作树中的生产文件。

页面验证：在 `/tmp/lobsterai-image-preview-smoke` 构建独立测试页，直接引用真实 `UserMessageItem`、`ImagePreviewModal` 和当前 Tailwind 样式，mock IPC 返回本地测试原图。浏览器确认：

- 未点击时读取次数为 0；点击 171×256 缩略图后读取次数为 1，弹窗图片自然尺寸为 1200×1800，按窗口显示为 363×544，文字可辨认。
- 切换到无路径旧记录后，点击未增加原图读取次数，仍可预览缩略图。
- 原文件缺失时仅调用一次读取并回退 171×256 缩略图，Escape 可正常关闭。
- 验证截图：`/tmp/lobsterai-image-preview-smoke/verified.png`。夹具源码、资源和截图均在仓库外。

未启动真实账号或 Gateway，未修改用户会话。以上页面检查使用模拟 IPC，不等同于手机真机到打包 Electron 客户端的端到端验收；该联调仍需补充。
