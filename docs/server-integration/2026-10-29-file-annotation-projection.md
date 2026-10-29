# 文件注释远程文本展示（2026-10-29）

## 变更摘要

桌面用户消息的 `browserAnnotations` / `imageEdits` 原先未进入远程文本投影，导致只有注释、没有正文的消息在手机显示空气泡。本轮桌面将可读评论、元素改动、图片区域文字转成既有 `text` block，同时保留原正文。

服务端没有新增接口或 DTO，只更新契约文档。完整[Spec](../../../lobsterai-server/docs/specs/mobile-remote-control/bugfix-2026-10-29-file-annotation-projection.md)及[手机接入说明](../../../lobsterai-server/docs/integration/2026-10-29-file-annotation-projection.md)以服务端仓库为准。

## 接口详情

- 手机仍通过 `GET /api/remote/v1/sessions/{sessionId}/messages/{messageId}` 及既有消息事件获取 `role=user, blocks=[{type:"text",text:"正文与注释说明"}]`；v4 保留稳定 blockId。
- 桌面仍通过 `POST /api/remote/v3/sync/live-projections` 发布，不新增请求字段。
- 历史空表示保持 object/source 身份，以新 publication、`representation=repair` 和核对后的 `expectedProjectionRevision` 修复。展示版本由服务端分配，不伪增 source revision。
- 本地注释格式版本和 worker 诊断标记不进入 wire payload 或 hash。

## 桌面行动项

- live、worker 历史和兼容投影共用文字转换；preview 使用最终正文。
- 只投影白名单文字，页面 URL、DOM、selector、完整本地路径、截图字节和 asset 标识留在本地。不通过注释显示读取文件或发起网络请求。
- 摘要有界且省略时明确提示；截图、标记图和纯视觉涂鸦仍需电脑查看。
- 历史自动修复仅在已有可核对 ACK 与原发布核对能力下分批执行；未知 pending 先核对，CAS 冲突不覆盖新消息或墓碑。旧模式随后续完整投影使用新文字转换，不保证仅重启/刷新就修复全部旧消息。

## 认证与发布

手机 JWT Bearer/设备凭证与桌面 owner、scope、环境、writer 授权保持不变。切账号、切环境、关闭同步或删除后旧任务不得继续补写。

仅需发布包含本轮修复的桌面版本；无本轮服务端代码或 SQL 变更，正式服和测试服无需为本轮同步发版。历史补齐以目标环境实际协商能力为准，不强制手机源码升级；需用实际旧 App 验收纯注释、图片评论和历史覆盖行为。
