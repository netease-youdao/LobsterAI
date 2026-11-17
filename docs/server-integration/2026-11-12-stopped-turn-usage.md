# 停止任务后的轮次积分（cancelled 请求入账）

**日期：** 2026-11-12
**服务端分支：** `lobsterai-server` `fix/stopped-turn-usage`（未部署）

## 1. Change Summary

客户端断开 `POST /api/proxy/chat/completions` 的 SSE（用户点击停止）后，服务端以前不记录这次请求。
现在会按已解析到的 token 补记一条 `status=failed` 的用量记录，
`GET /api/usage/llm-traces/{traceId}` 的汇总会包含它。

## 2. Endpoint Details

接口路径、请求、响应字段都不变。变化只在数据上：

- `requestCount` / `failedRequestCount` 会多算被取消的请求。
- `creditsUsed`：Anthropic 格式模型按输入 token 计费；OpenAI 格式模型（DeepSeek 等）中途取消时通常为 0。
- 被取消请求的账本记录在服务端检测到断开后写入，比客户端 token proxy 的 close 事件晚几百毫秒。

## 3. Frontend Action Items

本分支 `fix/stopped-turn-usage` 已包含：

- `main.ts`：`sessionStopped` 时调用 `settleCoworkTurnUsage()`。
- `AssistantTurnBlock.tsx`：没有可挂积分的最终文本回复时，在轮次末尾单独显示积分。

`CoworkTurnUsageService` 已有的 1.5 秒重试和 `refreshExactTrace` 会覆盖账本写入延迟，无需改动。

## 4. Auth Requirements

不变，仍用 JWT Bearer。

## 5. Notes & Caveats

- 两端可独立发布。只发客户端时，停止前已完成请求的积分能显示，被取消的那次请求不计入。
- 个人消费协议账号（审核 / IAP 隔离账号）的取消请求仍保持 pending，不补记。
