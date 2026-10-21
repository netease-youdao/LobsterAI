# Apple IAP 对账故障与新购隔离

日期：2026-10-21。状态：服务端源码变更，尚未部署或完成真实购买验收。

## 变更说明

单笔订阅对账失败、历史证据异常或任务积压不再关闭整个应用的新增购买。worker 完成一次调度并通过真实健康探测，即可积累购买准入所需的健康证据；失败任务继续原有重试与诊断，不被标记为已完成。

单个在售商品映射损坏时，products 只隐藏坏项，正常商品继续返回；坏商品的 purchase-context 仍严格拒绝。明确暂态的探测错误可以在原成熟健康证据有效期内重试，失败不刷新或延长成功证明。数据库或调度器不可用、健康证据过期、明确 Apple 配置/鉴权/非暂态验证故障仍限制新购。现代协议因共享配置错误或 429 进入整个 scope 的冷却期时，仍暂停新购。原账号订阅冲突、商品上架、验签、归属、幂等和生产验收要求不变。

## 接口、请求与认证

| 方法与路径 | 请求 | 认证 | 变化 |
|---|---|---|---|
| `GET /api/iap/apple/products` | 无 body；沿用 `Accept-Language` | 用户 JWT Bearer | 仍返回 `environment/products`；局部坏商品省略，正常项沿用原字段；采用新的健康判定 |
| `POST /api/iap/apple/purchase-context` | 原 `productId/idempotencyKey` | 用户 JWT Bearer | 请求及响应不变；采用相同的健康准入判定 |
| `GET /api/admin/iap/apple/reconciliation/health` | 无 query/body | IAM SSO Bearer、本地 ADMIN 和原 authority | 新增可选布尔字段 `fulfillmentOverdue`，只用于积压告警 |

所有响应仍用 `{code,message,data}`。health 保持 `Cache-Control: private, no-store`；scope 与 environment 由服务端部署决定，客户端不能覆盖。

健康正常但有单笔积压时，health 响应节选：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "ready": true,
    "reason": null,
    "pendingAgeSeconds": 7095,
    "fulfillmentOverdue": true,
    "isolatedPending": 0
  }
}
```

这是预期示例，不是发布后的实测结果。`ready` 表示共享健康准入结果；最终某用户能否购买仍以 products 和 purchase-context 为准。`pendingAgeSeconds` 保持最老待处理任务年龄的含义，不代表所有用户均有未交付订单。

purchase-context 请求示例：

```json
{"productId":"lobsterai.ios.standard.monthly","idempotencyKey":"c6434d2e-5bc0-41ee-a8bf-3af9f4a1d729"}
```

`idempotencyKey` 须由客户端为本次购买生成 UUID。响应保持原 `contextId/appAccountToken/productId/environment/expiresAt`；共享健康不足时仍为原 503/42212 可重试错误，商品不可用和订阅冲突错误语义保持。

## 消费端动作

- iOS 不需要同步升级。继续按 products 的 `purchasable/unavailableReason` 展示，并在购买前获取 purchase-context。服务端发布恢复后重新检查商品即可；按实际返回列表显示，不假定始终有四档套餐。
- Admin 可把 `fulfillmentOverdue=true` 显示为对账积压告警，不能据此推断全局不可购。旧版服务或依赖故障短响应可能没有该字段，缺省表示未知；仍通过 `ready/reason` 展示共享健康状态。
- Electron/Portal 的原支付与额度读取无需调整。iOS 源码当前不在本地，此文档同时供移动端接入人员参考。
- 迟到付款、恢复购买、通知、transactions/sync、sync-results 与 finishAllowed 沿用原契约。不能因为健康恢复便把旧未交付交易 finish 或再次扣款。

## 配置、发布与验收

无新增开关、DDL、数据迁移或协议切换，兼容 MySQL 5.7。原 `APPLE_IAP_HEALTH_PENDING_LIMIT_SECONDS` 默认 900，最小 60，现仅决定 `fulfillmentOverdue` 告警阈值。健康开关默认仍开启，不能关闭整个健康守卫来绕过购买检查。

先更新所有共享同一 scope 的 worker 实例，避免旧版本继续写入全局禁购状态。旧 `FULFILLMENT_OVERDUE/NO_WORK_PROGRESS` 不在读取时忽略；由新的真实健康观测自动清除，再满足至少 3 次成功、稳定至少 60 秒及原新鲜度条件。不手工改健康表、订单或验收引用。

发布后确认健康探测、心跳持续更新；在保留异常任务的情况下，其他无订阅冲突账号的商品可购且可创建 context。再验证实际 Sandbox 购买与履约、原异常任务重试、共享故障禁购及恢复。源码编译不等同于这些运行验收。


## 同日后续修订：商品隔离与暂态探测容忍

商品确定配置错误（缺套餐、积分缺失/负值、类型/周期错误）只影响自身；全部无有效商品仍报原配置错误，共享数据库异常不会伪装成成功目录。日志以内部商品记录 ID 和固定分类定位，无需客户端新增错误类型。

健康探测只容忍内部明确分类的暂态网络 IO、操作超时、资源队列暂满、可重试验证错误或可重试 Apple 远端错误（不含 429）。先有可信且成熟的健康证明才允许沿用：原 scope/代次、lease/fence、心跳、新鲜度和稳定期均须有效。失败后用数据库当前时间重新判断，默认最多到上次真实成功探测后的 120 秒；失败轮次不写 healthy，也不刷新 probeAt/successAt/observedAt 或稳定次数。记录 `iap.apple.worker.probe_retry` 后下轮继续真实探测，没有进程本地连续失败计数或新的 Redis 依赖。

持续失败超过原证明截止时间、冷启动、旧故障、失租约、配置/401/403、429 全局冷却、非暂态验证/格式/TLS 错误均不能借此放行。失败后原稳定恢复机制继续生效。公开 503/42212/retryable 契约不变，客户端不能根据 retryable 属性自行忽略购买失败。

发布后应额外对照验证：坏套餐在列表首尾均不影响正常套餐；一次暂态抖动不全局关购且成功时间不动；连续抖动不能延长截止时间；硬错误仍关闭。无 DDL、新开关或客户端同步升级要求，真实 Sandbox 和发布验收尚待执行。
