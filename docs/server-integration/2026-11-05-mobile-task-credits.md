# App 任务积分摘要接入（2026-11-05）

## 变更概要

App 使用现有远控会话同步读取两种可选展示快照：用户消息 `turnUsage` 表示本轮用量，session `taskUsage` 表示当前电脑本地会话用户轮次的累计。正文消息协议仍为 projection 4；能读取积分摘要的客户端协商 `task_credits_v1` 和 reader projection 6。

复用 `GET /api/usage/llm-traces/{traceId}?since=<epochMillis>&mediaTaskIds=<ids>` 的账本计费展示口径，由桌面主进程查询并持久化。App 不需要直接调用此接口，也不能按余额差、当前模型价格或 tokens 重新计费。这些数据是桌面同步的账本展示快照，不是扣款凭证，也不承诺等于账户余额实际减少额。

## 接口与协议

沿用 `GET /api/remote/v1/capabilities` 发现能力；服务端 `capabilities` 包含 `task_credits_v1`、`projectionVersions` 包含 `6` 时，升级客户端请求带 `X-Remote-Projection-Version: 6`。桌面同时确认 `reply_content_v1` 后才在设备能力中声明积分支持并生成新字段。会话列表、详情、历史消息和实时同步沿用原接口、游标和事件。

认证沿用 JWT Bearer、当前调用设备自己的 `X-Remote-Device-Credential`，以及现有 Data Space / Generation 头。App 不得使用桌面设备凭据。服务端仍按认证账号、scope、设备和会话授权读取；展示摘要中的 `billingScope` 不提供任何权限。

本轮摘要仅挂在原始用户消息，示例：

```json
{
  "messageId": "user-message-id",
  "role": "user",
  "projectionVersion": 4,
  "turnUsage": {
    "schemaVersion": 1,
    "source": "desktop_ledger_snapshot",
    "status": "settled",
    "billingScope": "personal",
    "displayCreditsUsed": "4.84",
    "requestCount": 3,
    "failedRequestCount": 0,
    "mediaPending": false,
    "updatedAt": "2026-11-05T05:50:00.000Z"
  }
}
```

状态为 `settled | partial | pending | failed`，scope 为 `personal | enterprise | unknown`。`pending/failed` 的金额为 `null`，不显示零积分；`partial` 金额为当前已统计金额，后续补记、退款或归属修正可能使金额变化。金额始终是两位十进制字符串，范围 `0.00` 至 `999999999999.99`。计数为 `0..2147483647` 的整数。缺少 scope 的旧摘要不会被默认为个人消费。不会同步 trace、tokens、完整用量元数据、模型供应商地址或提示词。

累计示例：

```json
{
  "sessionId": "remote-session-id",
  "taskUsage": {
    "schemaVersion": 1,
    "source": "desktop_ledger_snapshot",
    "scope": "local_session_turns",
    "sourceVersion": "142",
    "coverage": "partial",
    "totals": [{ "billingScope": "personal", "displayCreditsUsed": "9.68" }],
    "totalTurnCount": 3,
    "knownTurnCount": 2,
    "pendingTurnCount": 1,
    "unavailableTurnCount": 1,
    "updatedAt": "2026-11-05T05:50:00.000Z",
    "reasons": ["pending_usage"]
  }
}
```

`sourceVersion` 是当前本地会话源记录的持久单调版本（十进制字符串），用于拒绝旧历史快照覆盖较新累计。不要用时间戳排序。`updatedAt` 来自源记录时间，同一源版本保持稳定。

`coverage=complete` 仅表示当前本地用户轮次摘要覆盖完整，不代表账务最终结清、跨电脑累计或任务生涯全部费用。`partial` 表示有已知金额及缺口；`unavailable` 表示没有可计入的金额。个人和企业积分分别放在 `totals`，不得合成一个总数。

`knownTurnCount` 是计入金额的轮数；`unavailableTurnCount` 是已扫描但没有可纳入金额的轮数；`pendingTurnCount` 可以和前两者重叠，因此三者不能相加核对总数。扫描上限时 `totalTurnCount` 仍是全部本地用户消息数，其他计数只覆盖扫描范围。

原因枚举：`missing_usage`、`pending_usage`、`duplicate_attribution`、`scan_limit`、`unknown_scope`、`invalid_usage`。不能将缺失字段、未同步、旧版客户端、自定义外部模型无平台记录或扫描失败显示成 `0.00`。

## App 接入事项

1. 会话列表和详情展示服务端返回的 `taskUsage`；不要累加当前已加载消息页来计算任务总额。
2. 按 `userMessageId` 绑定本轮摘要，在该轮最终可见助手回复下展示一次。历史分页没有加载对应用户消息时，继续加载或保留本轮锚点；不要将费用附到下一轮，也不要从其他回复复制费用。
3. `settled` 显示 `4.84 积分`；`partial` 显示 `已统计 4.84 积分 · 更新中`，不承诺金额只会增加；`pending` 显示统计中；`failed` 显示暂不可用。企业 scope 使用企业积分文案，unknown 不推断账户类型。
4. 任务累计 partial 标注“已同步部分”，离线保留快照并显示更新时间。独立子 Agent 会话不递归叠加；父 trace 已包含的调用随原账本体现。
5. 以 message revision 更新单轮，以 taskUsage.sourceVersion 更新累计。重复同步只替换同一对象，不追加金额。
6. 使用完整 session 快照刷新累计；不能用某页没有 `taskUsage` 清空已知较新摘要。旧 reader 或功能关闭时按服务端兼容输出隐藏新展示。

## 桌面实现与边界

完成/失败、原生 IM/定时执行结束和媒体任务完成的主进程回调负责统计，不要求打开桌面会话页。Pending 现在也持久化，后续摘要更新会触发用户消息 revision 和会话控制 revision。历史用户消息按当前账号/scope和会话游标有界回补，每次最多读取64个索引头；能力关闭后曾启用的会话继续回补去除旧字段。同步暂时空闲不代表全部历史字段已清理。

累计扫描当前会话全部用户消息，最多 10,000 轮、4 MiB 原始 metadata，单条 metadata 上限 128 KiB；按会话源版本缓存。超限标 `scan_limit`，不会把截断结果标完整。trace/relatedTrace/media task 归属冲突的全部轮次都排除；fork 继承历史（不晚于 forked_at）不计入新任务累计，也不在新任务再次投影本轮费用，并标记归属缺口。旧账号目标历史、未公开 run 以及缺少当前账号来源证据的旧 run 金额不并入。不会递归扫描独立子会话。

两位金额优先复用服务端逐账单项舍入后的 `displayCreditsUsed`，旧摘要回退 `creditsUsed` 的两位展示值。客户端不改动额度扣减、计费账本和模型调用请求。

## 上线与验证

先服务端，再桌面和 App。新桌面连接未声明能力的旧服务端不产生新字段；旧桌面和旧 App 保持原行为。服务端关闭展示开关仍应严格验证并接收之前封存的合法摘要，不能阻塞正文和控制事实队列。封存请求的 operation ID/hash 不得为了降级直接改写；依现有 receipt/resolve/checkpoint 恢复流程确认后再生成兼容投影。已经写入新增字段后，不能承诺直接回滚到完全不认识该字段的旧服务端二进制仍无损；回滚窗口应保留 reader 字段过滤和兼容接收层，直至历史和封存请求完成可验证的处理。

最终定向验证共13个测试文件、501项通过，覆盖摘要、安全边界、实时/历史投影、真实磁盘worker、迟到更新、归属去重、封存请求恢复、有界历史回补及现有用量服务。本功能涉及的15个TypeScript文件按CI同等命令通过ESLint；`npx tsc --project electron-tsconfig.json --noEmit`通过。未启动真实 App/Electron 远控交互，也未运行服务端测试或连接外部数据库。
