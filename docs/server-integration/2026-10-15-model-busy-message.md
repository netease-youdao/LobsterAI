# 模型不可用提示文案统一（2026-10-15）

## 变更摘要

服务端 `ErrorCode.MODEL_BUSY` 的提示统一为“当前模型服务异常，暂不可用”，错误码仍为 `50304`。

## 接口影响

- `GET /api/models/available`：繁忙模型的 `restrictionHint` 返回新文案，示例字段如下；其余响应结构不变。
- `POST /api/proxy/v1/chat/completions`、`POST /api/proxy/v1/messages`：繁忙模型沿用现有 SSE 错误结构，错误码 `50304` 对应的错误消息改为新文案。请求参数不变。

```json
{
  "busy": true,
  "accessible": false,
  "restrictionHint": "当前模型服务异常，暂不可用"
}
```

## 客户端行动项

直接展示服务端提示；本地兜底文案同步为“当前模型服务异常，暂不可用”。错误判断继续使用错误码，不依赖提示文本。

## 认证与部署

沿用现有鉴权：模型目录支持 JWT Bearer、YID 会话及 OIDC 认证；桌面端代理请求继续使用 JWT Bearer。无权限变更，无数据库迁移；服务端发布后返回新文案。
