# 远程回复结束确认修复（2026-10-28）

## 变更摘要

服务端协议不变。桌面 OpenClaw 适配器区分“大工具结果 + 短回复”的短确认和真正的压缩/重试。纯长度风险沿用首次 8 秒确认，但不显示“正在整理上下文”，重复及并发 final 不重设等待期限。真实运行器续接仍可恢复，后续追问必须与旧轮次隔离。

日志、根因、手机接入要求和验收依据见服务端 [完整说明](../../../lobsterai-server/docs/integration/2026-10-28-remote-final-confirmation.md)。

## 沿用接口与认证

`POST /api/remote/v1/commands` 仍以 `Authorization: Bearer <accessToken>`、`X-Remote-Device-Credential: <mobileDeviceId>.<deviceKey>`、`Content-Type: application/json` 调用；个人与企业身份沿用主 API 第 3.1 节的身份认证及 scope 隔离。续聊请求沿用 `commandId/type=send_message/deviceId/sessionId/expectedControlVersion/expiresAt/payload.text`；响应仍为原 Command 信封。已使用输入 v2 的客户端继续其现有协议；无新增字段或错误码。

完整请求响应示例见[远控主 API 第 7.3、7.6 节](../../../lobsterai-server/docs/api/mobile-remote-api.md)。原身份、账号、scope、设备归属、命令 claim、执行许可和控制版本校验保持；短确认状态不能替代授权。

## 接入行动项

- 升级包含修复的桌面包，并核验包内代码。当前源码已有 8 秒常量本身不代表含本次重复 final 修复。
- 正文 final 与 run 终态分别处理；没有实际压缩证据时不能展示压缩提示。短确认完成后继续沿原远控同步链路发布 run 终态。
- 手机无需新增接口字段；保留追问草稿及其 commandId，直到对应用户消息到达。`SESSION_BUSY` 不自动重发新命令。手机源码由其工程独立验证，本次不修改。
- 验证重复 final、真实压缩、停止、换号，以及下一轮准备/运行/完成后旧轮次事件迟到的隔离。

## 发布与限制

无服务端代码、数据库、功能开关或接口认证变化；无需服务端发布，兼容 MySQL 5.7、旧服务和旧客户端。8 秒仅是弱证据下的本地确认窗口，不是所有任务的总时限。真机复验需记录手机请求、命令 ID、桌面运行及同步时间。
