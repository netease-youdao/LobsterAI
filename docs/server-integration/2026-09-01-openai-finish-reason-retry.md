# OpenAI SSE finish_reason 重试与错误返回

## Change Summary

`lobsterai-server` 现在会识别 OpenAI 兼容 SSE 中的异常 `finish_reason`：

- `network_error` 在没有产生正文、推理内容或工具调用时，会在同一模型、同一供应商端点额外重试 3 次；当前路由耗尽后才进入下一条模型路由。
- `sensitive` / `content_filter`、`model_context_window_exceeded` 和其他非标准终止原因不再按成功完成处理，而是转换为 OpenAI SDK 可识别的流内错误。
- 如果 `network_error` 前已经输出有效内容，服务端不会重试或切换路由，避免重复正文和重复工具调用。

## Endpoint Details

- Method: `POST`
- Path: `/api/proxy/chat/completions`
- Auth: `Authorization: Bearer <accessToken>`
- Content-Type: `application/json`
- Response: `text/event-stream`

异常终止时发送未命名的 SSE `data` 错误对象，随后发送 `[DONE]`：

```text
data: {"error":{"type":"upstream_finish_reason_error","code":50202,"message":"Provider finish_reason: network_error；模型服务网络暂时异常，已自动重试 3 次仍未恢复，请稍后重试。","finish_reason":"network_error","request_id":"upstream-request-id","retryable":true,"retry_count":3}}

data: [DONE]
```

错误码：

| finish_reason | code | retryable | 说明 |
|---|---:|---|---|
| `network_error` | `50202` | `true` | 同端点重试 3 次且可用路由耗尽后返回 |
| `sensitive` / `content_filter` | `50205` | `false` | 内容未通过安全审核 |
| `model_context_window_exceeded` | `50206` | `false` | 输入超出模型上下文窗口 |
| 其他非标准值 | `50201` | `false` | 未知上游异常终止 |

## Frontend Action Items

当前 OpenAI SDK 会在 SSE `data` 中发现 `error` 字段后抛出 API 错误，因此 LobsterAI 现有 OpenAI 流解析无需修改。

客户端如果直接读取错误详情，可使用：

- `error.message`：面向用户的明确错误说明，同时保留原始 `finish_reason` 文本以兼容现有错误分类。
- `error.finish_reason`：稳定的异常终止原因。
- `error.request_id`：最后一次上游请求 ID，用于问题排查。
- `error.retryable`：是否适合用户稍后重试。
- `error.retry_count`：服务端已经执行的额外重试次数。

## Auth Requirements

认证方式没有变化，仍使用 Electron 用户的 JWT Bearer Token。

## Notes & Caveats

- `retry_count=3` 表示首次调用之外又执行了 3 次请求，单路由最多调用 4 次。
- 服务端只会在尚未产生有效模型输出时自动重试。
- 服务厂商原始错误分片只写入服务端日志，不返回客户端。
- 本次变更没有修改请求体，也没有数据库迁移要求；建议服务端先于客户端版本发布。
