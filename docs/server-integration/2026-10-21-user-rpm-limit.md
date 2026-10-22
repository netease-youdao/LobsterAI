# 文本代理单用户 RPM 限流对接

## 变更摘要

Server 将对同一认证 userId 的所有文本模型、个人/团队身份及两个文本入口合并实施滚动 60 秒限制，默认 120 次，通过 Overmind 可动态调整或关闭。标题生成、工具续轮和客户端重试均计入；内部路由 fallback 不额外计数。正式付费用户及 ¥0.01 体验会员都适用。

## 接口和认证

- `POST /api/proxy/v1/chat/completions`
- `POST /api/proxy/v1/messages`

继续使用 Electron JWT `Authorization: Bearer <accessToken>` 以及现有个人/团队认证上下文。请求格式和正常 SSE 响应不变。

请求通过账号、模型及额度校验后，如最近 60 秒已放行数达到上限，在上游调用、积分扣费及 SSE 开始前返回 HTTP 429，Content-Type 为 JSON，`Retry-After` 为整数秒：

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 12
```

```json
{"error":{"type":"rate_limit_error","code":"user_rpm_limit_exceeded","message":"Too many requests. Please retry after 12 seconds."}}
```

这不是 `{code,message,data}` 业务响应，也不是 SSE error event。错误码与现有 engine_overloaded_error、额度不足错误不同。

## 客户端动作

1. 在消费 SSE 前检查 HTTP 状态和 JSON 错误体。识别 `error.code=user_rpm_limit_exceeded`，提示请求过于频繁及稍后重试；不展示为账号封禁或余额不足。
2. 透传并遵守 Retry-After，避免模型切换、个人/团队切换或多个 Agent 同时立即重试。该值是当前窗口最早可能释放名额的等待秒数，不预留名额；其他请求仍可能占用。
3. 保留用户当前会话/输入，使用有界退避和适当抖动。被拒请求不延长服务端窗口；持续重试也不会增加可用额度。
4. 已放行但上游失败的调用仍占 RPM 额度。关闭服务端限流或 Redis 故障临时放行时不会返回本错误。

本次仅提供对接说明，未修改 Electron 的运行时代码或重试行为。客户端现有行为须由后续消费方接入时核对。

## 发布与兼容

先部署 Server 异常监控表迁移，再发布 Server，随后发布 Admin。默认直接开启；需要回退时将 Overmind `proxy.user-rpm-limit` 改为 `{"enabled":false,"maxRequestsPerMinute":120}`。限流跨实例共享，不保证整个供应商的总 RPM 配额。本次交付未执行生产配置修改或部署。
