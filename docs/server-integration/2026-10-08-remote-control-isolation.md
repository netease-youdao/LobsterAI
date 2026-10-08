# 远控故障隔离接入说明（2026-10-08）

适用：App 接口开发、Electron 接入与服务端发布。本次没有修改手机 App 源码。完整协议和示例见 [接口文档](../../../lobsterai-server/docs/api/remote-control-isolation-2026-10-08.md)，不要把本文的消费方建议当作已上线手机行为。

## 变更摘要

新增服务端 `independent_subscriptions_v1`，允许 App 明确请求逐会话订阅结果；旧订阅保持原批量语义。旧 snapshot 的局部展示修复争用规范化为原 47014。HTTP 增加设备份额，沿用原 429 信封。存储有效控制索引与 operation 结果无损压缩不改变 API DTO。

## 接口与认证

1. `GET /api/remote/v1/capabilities`：沿用 `Authorization: Bearer <accessToken>`，从 `data.capabilities` 读取能力；设备接口继续传 `X-Remote-Device-Credential`。
2. 原 ticket/WS 链路：发送 `{"type":"subscribe","requestId":"sub1","catalog":false,"isolateSessions":true,"sessions":[{"sessionId":"s1","afterSeq":"0"}]}`；消费 `subscribed.sessions` 和 `subscribed.failedSessions`。示例 ID 仅作格式说明，真实请求使用原持久身份。
3. `GET /api/remote/v2/sessions/{sessionId}/read-view`：已有能力 `partial_read_view_v1` 加 `X-Remote-Projection-Version: 5`；原设备、grant、scope 校验保留。
4. 命令接口及字段不变。任何 partial/resync/429 都不授权更换原命令 ID 或绕过执行核对。

## App 行动项

- 目录单独订阅。支持新能力时可批量发会话并逐项消费结果；不支持或新字段被旧节点拒绝时，去掉字段，分任务发旧格式 subscribe。只重试失败的会话。
- `requestId` 对应一次订阅请求；`sessionId` 对应展示状态。同一 WS 中 A 的 resync/47014 只更新 A，保留 B 的订阅、游标、已加载消息和草稿。共享鉴权失效仍按原账户流程处理。
- 成功项仍检查 seq 连续性；失败项不能推进 ACK。47008/47015 重新取目标会话基线；47010 按既有删除语义；47014 按 retryAfterMs 重试。不要将 `decisions.state=partial` 解释成没有待办。
- 429 合并轮询和目录刷新，保留草稿及原请求核对；503 使用共享依赖退避。新能力不意味着设备在线或控制已经就绪。
- 验收：五任务中一任务坏历史、初次批量与已建立订阅、读修复锁冲突、共享 DB/鉴权失败、断线重连、命令结果未知、旧服务端未知字段回退。

## Electron 行动项

无需消费手机专用订阅能力。继续原 capability 协商、同 ID/hash 重放、控制核对和 target fencing。新图片输入使用独立沙箱 renderer，静态 PNG/JPEG/GIF/WebP 的预检资源上限详见实施记录；必需输入资源拒绝内部使用 INPUT_UNSUPPORTED，App/服务端仍看到既有 failed / PREPARATION_FAILED，不新增错误 reason，也不将缺图命令静默当成文本执行。

账号 fence 持续低频恢复，切号时旧代次不能释放新账号凭据；局部 GC/问题证据恢复不会清除原执行账本。本次修改已在桌面仓库实现，无须手机同步升级才能使用这些修复。

## 发布顺序和注意事项

先核对既有迁移，再增量部署 V110/V111；兼容 reader 全量部署后才允许分别声明 result compression readiness 和 control coverage readers readiness；后者还要求所有历史分片核验/核对/GC 节点理解已覆盖 committed 行退休，原 checkpoint writer 证明不能替代。普通功能开关默认开启，部署证明保持 false，不能由默认值推断已通过验收。新存储格式出现后关闭开关不等于可以回退旧构建。

V109 的历史测试执行不覆盖 V110/V111；本次已独立完成 [测试库 V110/V111 执行与复核](../../../lobsterai-server/docs/operations/2026-10-08-test-v110-v111.md)，生产未执行。服务端只编译，未执行服务端测试。保留既有 URL、字段类型、错误码、认证，旧 Portal、App、Electron 可继续使用已有接口。

服务端实施与完整限制：[第二批实施记录](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-10-08-rereview-implementation.md)。
