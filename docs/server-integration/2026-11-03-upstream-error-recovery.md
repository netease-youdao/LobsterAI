# 上游请求错误保真协议

## 变更摘要

服务端保留路由最终失败时明确的请求拒绝原因。Electron 声明新能力后，可识别上下文超限，
进入已有恢复流程。接口路径、JWT 认证和请求体不变。

## 接口详情

`POST /api/proxy/chat/completions`，继续使用 `Authorization: Bearer <accessToken>`。
在原 `X-LobsterAI-Client-Capabilities` 头中追加可选能力 `upstream-error-details-v1`。

识别上游 HTTP 400/422 的以下错误，使用已有错误码：

| category | code | 含义 |
| --- | --- | --- |
| `response_format_unsupported` | `50204` | 输出格式不支持 |
| `reasoning_content_missing` | `50204` | 要求回传的思考历史字段缺失 |
| `context_window_exceeded` | `50206` | 超过模型上下文窗口 |

其他路由仍可继续尝试；最终失败为上述拒绝时，新客户端收到 HTTP 200 的 SSE error，随后结束：

```text
data: {"error":{"type":"upstream_error","code":50206,"category":"context_window_exceeded","message":"This model's maximum context length is exceeded.","retryable":false,"upstream_status":400,"trace_id":"<trace-id>"}}

data: [DONE]
```

HTTP 200 不代表模型成功，需处理 error 事件。`retryable:false` 表示不应原样重发，
允许缩短上下文后恢复。消息有长度限制，`trace_id` 可用于关联服务端诊断。

## 客户端接入

- 在既有能力列表追加新能力，复用现有 token proxy 与 SSE 错误解析。
- 上下文恢复失败时保留原会话，提示缩短输入或分批发送。
- 重建包含 compaction 版本补丁的 OpenClaw 运行时；仅编译 Electron 不会更新原生重试逻辑。

## 兼容与发布顺序

旧客户端不声明能力，继续原 HTTP 状态和 JSON；新客户端连接旧 server 继续原行为。
可先部署 server，再发布 Electron，Portal 无需同步升级。
不改变认证或权限，不需要数据迁移，也没有新增服务端功能开关。
本次不转换输出格式、不补造推理历史，也不扩展 Anthropic 等其他接口。
