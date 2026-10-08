# 本轮积分消耗与模型请求追踪

## Change Summary

Server 的 LLM 代理（`/api/proxy/v1/chat/completions`、`/api/proxy/v1/messages`）读取请求头 W3C `traceparent`，把 trace-id（本轮对话）与 span-id（单次模型请求）写入用量账本，并在请求日志中与服务端 8 位 traceId 同行打印；响应头 `X-Lobster-Trace-Id` 回传服务端 traceId。新增 `GET /api/usage/llm-traces/{traceId}` 按 trace 汇总本轮的请求次数、token 与积分。

## Endpoint Details

模型代理：请求头可带 `traceparent: 00-<32 位 trace-id>-<16 位 span-id>-01`；格式非法时忽略，不影响请求。响应头新增 `X-Lobster-Trace-Id: <服务端 traceId>`。

本轮汇总：`GET /api/usage/llm-traces/{traceId}?since=<本轮开始 epoch 毫秒>`。`traceId` 为 32 位小写十六进制；`since` 用于限定查询窗口（服务端取 `since - 30 分钟` 到 `since + 24 小时`）。

```json
{"code":0,"message":"success","data":{
  "traceId":"4bf92f3577b34da6a3ce929d0e0e4736","billingScope":"personal",
  "requestCount":6,"failedRequestCount":0,"models":["deepseek-v4.1-flash"],
  "creditsUsed":12.5,"uncachedInputTokens":3659,"cacheReadTokens":1152640,"cacheWriteTokens":0,
  "inputTokens":1156299,"outputTokens":7508,"totalTokens":1163807,
  "firstRequestAt":1790000001000,"lastRequestAt":1790000070000}}
```

`inputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens`，`totalTokens = inputTokens + outputTokens`。`billingScope` 为 `enterprise` 时表示扣的是团队积分。traceId 非法或缺少 `since` 返回 `4000`。

## Frontend Action Items

- 每轮对话生成 trace，存到该轮用户消息的 `metadata.llmTrace`，并通过 `chat.send` 请求帧的 `traceparent` 交给 OpenClaw；OpenClaw 为每次模型调用生成子 span，本地 token 代理原样转发给 Server。需要 `openclaw-gateway-client-request-traceparent.patch`，升级后要重建 OpenClaw runtime。
- 本地 token 代理按 trace 记录请求数，并逐条打印 `LLM request started/finished trace=… span=… serverTrace=…`。
- 本轮结束（含失败）后，若该 trace 走过套餐模型，主进程调用汇总接口，把结果存到用户消息的 `metadata.turnUsage`，并推送 `cowork:stream:turnUsage`；Server 记账少于代理观察到的完成请求数时重试一次，仍不足则标记为部分结算。
- 最后一条回复的元信息行展示积分图标、积分与本轮耗时，点击打开明细：请求次数与模型、缓存命中率、未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 合计、耗时、Trace ID（可复制）。

## Auth Requirements

两处均使用 Electron JWT（`Authorization: Bearer`）。汇总接口只返回当前登录用户在当前账号上下文（个人或团队）账本中的记录，客户端不传用户或团队 ID。

## Notes & Caveats

- 先执行 Server `sql/V104__llm_request_trace.sql`（`api_call_logs`、`tob_enterprise_usage_records` 新增可空列，不建索引），再发布 Server，最后发布客户端。旧客户端不带 `traceparent`，行为不变。
- 迁移前写入的记录没有 trace，历史对话不显示积分入口。
- IM、定时任务等不经客户端 `chat.send` 发起的对话没有客户端 trace，不显示入口；这些请求仍有 OpenClaw 生成的 trace/span，日志可对上。
- 子 Agent 的模型请求、子 Agent 汇报后父任务的续跑是否沿用本轮 trace，取决于 OpenClaw 内部调度，尚未验证；未沿用的请求不计入本轮汇总，但各自仍有可对上的 trace/span 日志。
