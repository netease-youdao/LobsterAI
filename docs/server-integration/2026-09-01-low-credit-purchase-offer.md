# 低余额限时购买优惠联调说明

日期：2026-09-01

## 变更摘要

服务端新增按登录用户签发的低余额限时优惠。优惠令牌仅用于定位服务端优惠记录，不能决定折扣或价格；服务端会重新校验用户、活动、有效期和商品，并计算最终订单金额。

活动默认关闭。每个 `campaignCode` 每位用户最多生成一条优惠记录，每条优惠最多核销一笔成功订单。历史付费用户的同一条 9 折优惠记录最多可承载两个连续触发阶段的倒计时窗口，但这不会增加可核销次数。

## 接口

### 激活低余额优惠

`POST /api/purchase-offers/low-credit/activate`

认证：

- Electron：`Authorization: Bearer <accessToken>`
- Portal：Cookie/Session 或 Bearer Token

无请求体。响应示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "status": "active",
    "reason": null,
    "offerToken": "7f37c9388a3546cdb1f861bab31bbff3",
    "offerType": "first_purchase",
    "campaignCode": "low_credit_purchase_2026_09",
    "discountRate": 0.50,
    "eligibleProducts": ["subscription"],
    "defaultTab": "subscription",
    "creditsRemaining": 99.81,
    "thresholdCredits": 100,
    "triggerStage": "low_balance",
    "windowCount": 1,
    "serverTimeEpochMs": 1788235200000,
    "startsAtEpochMs": 1788235200000,
    "expiresAtEpochMs": 1788237000000
  }
}
```

`status` 可能为 `active`、`expired`、`redeemed`、`ineligible`、`disabled`。企业身份返回 `ineligible`，不会生成优惠记录。

历史付费用户的 9 折倒计时规则：

- 余额首次进入 `0～500` 时开启第一个 30 分钟窗口，`triggerStage=low_balance`。
- 第一个窗口未结束时余额变为 0：沿用同一 `offerToken` 和原 `expiresAtEpochMs`，只把阶段更新为 `exhausted`，不重置倒计时，也不会再开启第二个窗口。
- 第一个窗口已经结束后余额才变为 0：复用同一优惠记录和令牌开启一次新的 30 分钟窗口，`windowCount=2`。
- 首次触发时余额已经为 0：直接记为 `exhausted`，只有一个窗口。
- 任一窗口内成功支付后状态变为 `redeemed`，同一用户在本期活动中不能再次获得 9 折。

### 校验当前优惠

`GET /api/purchase-offers/current?offerToken=<token>`

Portal 登录后调用。令牌与当前账号不一致返回 42101。前端倒计时必须以 `serverTimeEpochMs` 和 `expiresAtEpochMs` 计算，并在窗口聚焦或页面恢复时重新请求校时。

### 创建订阅订单

`POST /api/subscription/create`

```json
{
  "planId": 2,
  "paymentChannel": "unified",
  "offerToken": "可选"
}
```

### 购买预设或自定义加油包

`POST /api/boost-packs/purchase`

```json
{ "boostPackId": 1, "paymentChannel": "unified", "offerToken": "可选" }
```

或：

```json
{ "amount": 100, "paymentChannel": "unified", "offerToken": "可选" }
```

优惠订单响应会额外返回：

```json
{
  "orderNo": "LB...",
  "qrCodeUrl": "...",
  "amount": 50.00,
  "originalAmount": 100.00,
  "discountRate": 0.50
}
```

没有 `offerToken` 时沿用原价和现有支付流程。

## 资格与商品范围

- 从未成功支付个人订阅或加油包、个人可用积分 0～100：全部付费订阅套餐首笔 5 折。
- 历史个人付费用户、个人可用积分 0～500：9 折。
- 活跃订阅用户的 9 折仅适用于加油包；非活跃历史付费用户适用于订阅和加油包。
- 付费历史按个人订阅/加油包订单 `paid_at IS NOT NULL` 判断，退款后仍属于历史付费用户；企业订单不计入。
- 自定义加油包按原始面额发放积分，按折后金额收款。
- 订阅后续自动续费使用套餐原价。

## 错误码

| 错误码 | 含义 |
|---|---|
| 42100 | 无效令牌或活动不匹配 |
| 42101 | 当前账号与优惠账号不匹配 |
| 42102 | 优惠过期或已核销 |
| 42103 | 商品不适用 |
| 42104 | 优惠已被另一商品的待支付订单锁定 |

## 价格快照与幂等

优惠订单记录 `purchase_offer_id`、`original_amount` 和 `discount_rate`。同一优惠和同一商品重复创建会返回原待支付订单；换商品返回 42104。失败或关闭的订单可在优惠剩余时间内重建。支付成功后服务端在同一事务中核销优惠。

优惠倒计时结束后不能创建新的折扣订单；到期前已创建的订单按订单自身支付有效期和价格快照继续支付。

## 配置与上线顺序

Overmind key：`low-credit-purchase-offer`

以下字段全部由 Overmind 提供，服务端不再读取 `application.properties` 中的活动默认值。配置不存在时活动关闭；配置解析失败时保留最后一次合法配置。首次上线请先写入完整的 `enabled=false` 配置：

```json
{
  "enabled": false,
  "campaignCode": "low_credit_purchase_2026_09",
  "durationSeconds": 1800,
  "firstPurchaseThreshold": 100,
  "firstPurchaseDiscountRate": 0.50,
  "returningThreshold": 500,
  "returningDiscountRate": 0.90
}
```

上线顺序：

1. 执行 V84 数据库迁移。
2. 发布服务端，保持 `enabled=false`。
3. 发布 Portal 和 Electron 客户端。
4. 核对接口、账号绑定、倒计时和普通订单原价。
5. 设置新的 `campaignCode` 后开启活动。

更换 `campaignCode` 才会让同一用户获得新一期资格。
