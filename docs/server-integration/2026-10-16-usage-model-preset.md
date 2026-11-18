# 调用模式用量字段

## 请求协议

现有 `POST /api/proxy/v1/chat/completions` 及 Anthropic `POST /api/proxy/v1/messages` 请求可增加：

```text
Authorization: Bearer <accessToken>
traceparent: 00-<turnTraceId>-<requestSpanId>-01
X-Lobster-Session-Id: <sessionId>
X-Lobster-Turn-Id: <turnTraceId>
X-Lobster-Model-Preset: ultimate
```

`X-Lobster-Model-Preset` 仅接受 `balanced` / `ultimate`。它是可选展示元数据，必须有合法且匹配的会话/轮次上下文；未知值被忽略，不中断调用。旧客户端不带此头继续兼容。请求体 `model`、代理响应、鉴权、模型路由及扣费保持原语义。

## 客户端

在开始用户轮次时捕获消息中保存的 `modelPresetId` 和 `resolvedModelId`，绑定到该轮 trace。Token Proxy 仅在本次请求体模型与捕获的实际模型相同时发送模式头；不读取后续的全局选择，不按模型候选列表推测。

直接选模型、未注册 trace、其他工具模型和媒体账单不添加模式。并行会话按各自 trace 隔离。接口用途仅为个人账单的 Portal 展示，企业账单字段不在本次范围。

## 服务端和 Portal

个人调用日志存储 `model_preset_id`；Portal `/api/user/usage-conversations` 系列接口增加 `modelPresetId`，轮次列表另增加 `modelSelections`，保留原始 `model` / `models`。例如 `{ "model": "qwen3.8-max", "modelPresetId": "ultimate" }` 展示为“极致（qwen3.8-max）”。

## 发布顺序与历史记录

先执行服务端 `sql/V122__usage_model_preset.sql`，再部署服务端及更新客户端。旧服务会忽略新请求头；旧客户端及历史记录无模式字段时保持原模型名。本次不推测回填历史记录，未执行数据库迁移或部署。
