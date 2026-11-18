# 轮次积分按逐笔用量明细汇总展示

## 修改说明

用量明细中的每笔消耗保留两位小数，轮次弹窗按这些逐笔展示金额汇总。
原始 `creditsUsed` 继续保留账本精度，新增 `displayCreditsUsed` 供展示使用。
本次不修改账本扣费、余额、Token 估算或缓存节省额，也不向下调整 Token 分项来凑原始总额。

## 接口与鉴权

`GET /api/usage/llm-traces/{traceId}?since={epochMs}&mediaTaskIds={ids}`

继续使用现有 Electron JWT Bearer 鉴权及企业上下文，参数、权限和响应包装不变。

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "creditsUsed": 607.203752,
    "displayCreditsUsed": 607.21,
    "modelUsage": [
      { "type": "text", "model": "deepseek-flash", "creditsUsed": 7.203752, "displayCreditsUsed": 7.21 },
      { "type": "video", "model": "HappyHorse-1.1", "creditsUsed": 600, "displayCreditsUsed": 600.00 }
    ]
  }
}
```

上例只列出本次相关字段，其余字段不变。

服务端对每笔文本账本及每个已结算媒体任务的真实扣分执行十进制 `HALF_UP` 两位舍入后求和。
模型小计和轮次总额使用同一规则。先按现有逻辑筛选归属、结算状态、退款和重复媒体任务。
不通过 Token 价格估算推导这些账本展示金额。

例如 `6.795240 + 0.221872 + 0.186640 = 7.203752`，逐笔展示为
`6.80 + 0.22 + 0.19 = 7.21`；加视频 `600.00` 后本轮展示 `607.21`。

## 客户端接入

- 类型及响应解析保留可选的 `displayCreditsUsed`，支持 JSON 数字和十进制字符串。
- 消息积分入口、弹窗总额和模型小计优先展示该字段，包含合法的零值。
- Token 明细继续独立格式化原始估算值，不能为了匹配合计篡改分项；估算与账本不必完全一致。
- 诊断信息、缓存节省额及其他真实用量计算继续使用原始 `creditsUsed`。

## 兼容与发布

服务端先发布，再发布客户端。旧服务端或旧历史消息缺少新字段时，客户端保留原始合计的展示，
不能仅凭模型总额或 Token 估算反推逐笔舍入结果。新服务端上线后，打开积分弹窗会触发现有刷新，
将新展示金额写入该轮本地元数据。无需数据库迁移或修改历史账本。
