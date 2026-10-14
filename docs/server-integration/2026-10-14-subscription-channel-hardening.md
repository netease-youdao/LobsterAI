# Electron：订阅互斥错误兼容接入

日期：2026-10-14。本次不修改 Electron 或手机 App 源码。服务端实现见 [补强方案](../../../lobsterai-server/docs/specs/payment/feature-2026-10-14-subscription-channel-hardening.md)，手机 App 接口要求见 [iOS 接入增补](../../../lobsterai-server/docs/integration/2026-10-14-subscription-channel-hardening.md)。

## Change Summary

服务端修复旧支付/签约回调恢复自动续费的问题，续费重试保留每个原始订单号，并为原订阅错误增加可选原因。Web/Apple 订阅互斥；Apple 用户仍可通过 Web 购买加油包。现有跳转 Portal 的购买入口继续使用，旧 Electron 无须同步升级。

## Endpoint Details

- `GET /api/subscription`：请求和响应语义保持，读取当前渠道状态。请求头继续 `Authorization: Bearer <accessToken>`；Portal 使用既有 Cookie/Session。
- `POST /api/subscription/create`：请求仍为 `{"planId":3,"paymentChannel":"unified"}`；升级仍为 `POST /api/subscription/change` 和 `{"newPlanId":3,"paymentChannel":"unified"}`。无新增必填字段。
- 冲突仍使用原 HTTP 和业务码（创建 `40403`；升级按原规则 `40403/40404`），可增量返回：

```json
{
  "code": 40403,
  "message": "已有 Apple 订阅，请前往 Apple 管理订阅，避免重复购买",
  "data": {
    "subscriptionChannelConflict": {
      "reason": "subscription_active",
      "channel": "apple",
      "message": "当前订阅或续费仍由Apple管理，请先在原渠道取消自动续费，并等待已购权益到期"
    }
  }
}
```

reason 还有 `purchase_in_progress`、`payment_conflict`；channel 为 `web` / `apple` / null。仅在途预约提供可选 `retryAfterSeconds` 正整数。详情缺省或未知值时仍可显示原 message。接口全集见 [Payment API](../../../lobsterai-server/docs/api/payment-api.md)。

## Frontend Action Items

当前 Electron 的付费入口继续打开 Portal，由新版 Portal 和服务端共同确认资格。本次无需改 Electron 支付流程。将来若增加直接下单界面：

1. 订阅状态加载失败时提示重新检查，不视为免费用户直接付款。
2. 仅 `subscription_active + apple` 提供 Apple 管理；说明取消自动续费后仍须等待权益到期才能换渠道。
3. `purchase_in_progress` 提示等待后重新检查，不自动付款；`payment_conflict` 提示联系客服，不能重复下单。
4. `paid + needs_support` 沿用人工处理展示，不宣称已开通。加油包独立购买，不复用订阅互斥门控。

## Auth Requirements

沿用当前 JWT Bearer / Portal Cookie-Session 权限，服务端从认证决定账号。没有新增认证参数、来源白名单或客户端最低版本。

## Notes & Caveats

服务端需先暂停旧续费 Job、执行 MySQL 5.7 兼容 V117、升级全部服务端/任务实例，再恢复 Job。新字段均可选，旧客户端兼容；多 attempt 数据产生后不能直接回滚旧续费任务。原订单号已经被历史代码覆盖的情况仍须渠道对账人工核对。

本接入文档不代表已经部署或完成手机 UI / Sandbox 验收。Electron 仅文档变更，未运行 Electron 测试。
