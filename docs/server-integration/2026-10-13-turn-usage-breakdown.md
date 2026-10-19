# 每轮积分消耗分项展示

## 变更摘要

`GET /api/usage/llm-traces/{traceId}` 新增 `modelUsage` 和 `mediaPending`。原有 Token 汇总及 `requestCount` 仍只统计文本请求。`creditsUsed` 为文本账本实际扣分加本轮已结算媒体实际扣分，不包含冻结金额或缓存节省额。

## 接口

- 认证：Electron JWT `Authorization: Bearer <accessToken>`；沿用当前个人/企业登录上下文。
- 参数：`since`（必填，毫秒时间戳）；`mediaTaskIds`（可选，最多 50 个正整数，逗号分隔）。
- 示例：`GET /api/usage/llm-traces/4bf92f3577b34da6a3ce929d0e0e4736?since=1791875159000&mediaTaskIds=123,124`
- 媒体任务按 userId、accountMode、enterpriseId 和原有时间窗口核验；无权访问、窗口外及重复 ID 不计入。
- 响应仍为 `{ "code": 0, "message": "success", "data": { ... } }`。

新增字段示例（仅为协议示例，非线上账单）：

```json
{
  "creditsUsed": 43.78,
  "mediaPending": false,
  "modelUsage": [
    {
      "type": "text",
      "model": "example-text-model",
      "count": 2,
      "creditsUsed": 21.78,
      "uncachedInputTokens": 105000,
      "cacheReadTokens": 139000,
      "cacheWriteTokens": 0,
      "outputTokens": 282,
      "tokenCreditEstimate": null
    },
    {
      "type": "image",
      "model": "example-image-model",
      "count": 1,
      "creditsUsed": 22,
      "uncachedInputTokens": 0,
      "cacheReadTokens": 0,
      "cacheWriteTokens": 0,
      "outputTokens": 0,
      "tokenCreditEstimate": null
    }
  ]
}
```

`type` 为 `text` / `image` / `video`；文本 `count` 为请求次数，媒体 `count` 为实际结果数量。

可选 `tokenCreditEstimate` 包含 `uncachedInput`、`cacheRead`、`cacheWrite`、`output`、`cacheSavings`（积分），以及可选 `pricingPeriod`（`peak` / `off_peak` / `mixed`）。服务端按 `model_id` 查询 `model_pricing` 的积分单价，结合请求 Token 档位及计价时段计算展示估算值；不再因模型 `updated_at` 晚于请求时间或重算金额与账单不同而隐藏。缺少模型价格、请求时间或实际账单扣分时返回 null，不能把缺失扣分当作零消耗。`creditsUsed` 仍取实际账单扣分。

缓存节省额按每次请求的 Token 档位和高峰/低峰价格计算，单价单位为积分/百万 Token：

```text
单次无缓存理论费用 = (全部输入 Token × 普通输入单价 + 输出 Token × 输出单价) ÷ 1,000,000
单次净节省额 = 单次无缓存理论费用 − 该条文本请求账单实际扣分
本轮节省额 = max(0, 所有文本模型、所有请求的净节省额之和)
```

全部输入 Token 使用账单的 `inputTokens`，已包含缓存命中部分，不再额外相加。实际扣分使用该条记录的 `creditsUsed` 原始精度，不使用页面四舍五入后的金额，也不使用按缓存读取价格重算的费用。缓存读取价格仅用于 Token 分项展示，不参与节省额计算；不读取独立缓存写入价格。图片、视频任务的实际扣分仍计入本轮总消耗，但完全不参与缓存节省额计算。

模型级 `cacheSavings` 保留负差额（理论费用低于实际扣分时），客户端必须先跨模型相加，再将最终结果限制为不小于零，不能逐条或逐模型截断。零值、不完整结算或任一文本模型估算缺失时不展示节省提示；正值展示“缓存已帮你省下约 X 积分”。该值不参与本轮实际消耗或占比条，也不能再次抵扣。

## 同步媒体任务补齐

`POST /api/media/images/generate` 的个人同步生图成功结果现在同样写入 `media_generation_tasks`，返回非空 `taskId`。任务保存 `actualCredits`、完成状态、模型和生成结果，任务入库与预扣差额结算在同一事务中完成；失败时撤销该事务并退回原预扣。同步完成的视频也采用这一结算流程，按上游实际用量计算费用。

认证仍为 JWT Bearer，个人/企业账号上下文不变。请求格式不变，例如：

```json
{ "model": "example-image-model", "type": "t2i", "prompt": "cat", "params": { "n": 1 } }
```

成功响应示例（其余已有字段省略）：

```json
{ "code": 0, "message": "success", "data": { "taskId": 123, "model": "example-image-model", "type": "t2i", "status": "succeeded", "progress": 100, "resultUrls": ["https://example.com/image.png"], "billingScope": "personal", "billingStatus": "legacy", "estimatedCredits": 50 } }
```

`estimatedCredits` 仍为预估值，客户端应传 `taskId` 给本轮用量接口，由服务端返回实际扣分，不能用预估值相加。

## 客户端接入

1. 发起生成工具请求前捕获本轮用户消息 ID；生成成功受理后将服务端任务 ID 写入该消息 `turnMediaTaskIds`，避免异步结果归到下一轮。
2. 结算或刷新时传入这些 ID；只有媒体调用的轮次也触发查询。
3. 按 `modelUsage` 显示分类：文本及缓存绿色、图片紫色、视频橙色。占比条只使用实际消耗。
4. `mediaPending=true` 表示仍有任务生成/结算/退款中，显示部分结算状态并允许刷新；不能把冻结金额作为消耗。
5. 诊断复制包含 trace、消息/会话 ID、耗时及用量数据；用量明细按个人/团队上下文打开对应 Portal 页面。
6. 异步图片/视频任务结束后刷新其原始用户消息的用量，避免费用显示滞后或归到下一轮。
7. 默认弹层保留缓存读取 Token 和对应估算费用，并按上述规则展示本轮缓存节省额；悬停说明包含配置价计算口径及不重复抵扣的提示。每次打开弹层刷新摘要，让已有轮次也取得新口径。

## 兼容与发布

- 无数据库迁移或新增配置；沿用已有定价和预扣差额结算规则。先发布服务端，再发布客户端。
- 旧客户端不传媒体任务 ID，保持原有文本统计行为。
- 旧服务端/旧本地摘要无 `modelUsage` 时展示文本汇总和缓存读取 Token，不推算未知金额；打开旧弹层时刷新。
- 升级前未保存 `turnMediaTaskIds` 的历史轮次只保留原有文本统计，不能按时间猜测媒体归属。
- 部分结算时总积分仍为下界；原有 1000 条文本账本上限保持不变。
