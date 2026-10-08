# 低余额限时购买优惠：dev-deploy 接入说明

日期：2026-09-14

本文保留当时合并及验证记录。成功付款资格与旧返购纠正已于 2026-09-15 更新，以[2026-09-15 成功付款资格说明](2026-09-15-successful-payment-offer-eligibility.md)为准；不改变已有待支付订单价格快照和锁。

## 变更摘要

服务端将低余额限时购买优惠合入 `dev-deploy`。低余额优惠错误码由 `42200～42204` 调整为 `42300～42304`，避免与测试分支已有业务错误码冲突。接口路径、请求字段、响应结构和优惠窗口规则不变。

客户端当前 `feat/low-credit-purchase-offer` 分支已实现激活优惠、倒计时和 Portal 跳转；没有硬编码上述业务错误码，本次无需修改客户端运行代码。完整资格、幂等和窗口规则见 [原联调说明](2026-09-01-low-credit-purchase-offer.md)。

## 接口与认证

所有响应沿用 `{ "code": 0, "message": "success", "data": ... }`。

### 激活优惠

`POST /api/purchase-offers/low-credit/activate`

Electron 请求头：

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
```

无请求体。用户身份由服务端解析，不接受客户端传入用户 ID、折扣或价格。企业身份返回 `ineligible`，不创建个人优惠。

响应示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "status": "active",
    "reason": null,
    "offerToken": "example-user-bound-offer-token",
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

时间和令牌仅为示例。`status` 可能为 `active`、`expired`、`redeemed`、`ineligible`、`disabled`。`receivedAtEpochMs` 由客户端收到响应时补充，不是服务端响应字段。

### 校验当前优惠

`GET /api/purchase-offers/current?offerToken=<token>`

Portal 登录后通过 Cookie/Session 或 Bearer Token 请求；成功响应与激活接口相同。令牌只定位服务端优惠，不提供登录身份。服务端重新校验当前账号、活动和优惠状态。

账号不匹配响应示例：

```json
{ "code": 42301, "message": "优惠不属于当前账号", "data": null }
```

### 下单

以下请求由 Portal 发起，使用其当前 Cookie/Session 或 Bearer 登录身份。Electron 只跳转 Portal，不直接创建支付订单。

订阅：`POST /api/subscription/create`

```json
{ "planId": 2, "paymentChannel": "unified", "offerToken": "example-user-bound-offer-token" }
```

加油包：`POST /api/boost-packs/purchase`，预设包与自定义金额二选一：

```json
{ "boostPackId": 1, "paymentChannel": "unified", "offerToken": "example-user-bound-offer-token" }
```

```json
{ "amount": 100, "paymentChannel": "unified", "offerToken": "example-user-bound-offer-token" }
```

下单响应的 `data` 包含最终订单金额及优惠快照，例如原价 100 元的 9 折订单：

```json
{
  "orderNo": "LB_EXAMPLE",
  "qrCodeUrl": "https://example.com/payment/route",
  "amount": 90.00,
  "originalAmount": 100.00,
  "discountRate": 0.90
}
```

以上是相关字段节选；二维码字段及支付流程以实际服务端响应为准。不传 `offerToken` 时沿用现有普通购买流程。自定义加油包按原始面额发放基础积分，按折后金额收款；订阅后续自动续费仍使用套餐原价。低余额优惠与个人限时充值活动同时生效时，加油包赠送资格按服务端最终订单金额判断；例如原始面额 50 元、9 折后订单金额 45 元，不满足满 50 元赠送门槛。客户端不自行计算订单价格或活动赠送积分。

## 新错误码

| 错误码 | 含义 |
|---|---|
| 42300 | 无效令牌或活动不匹配 |
| 42301 | 当前账号与优惠账号不匹配 |
| 42302 | 优惠过期或已核销 |
| 42303 | 商品不适用 |
| 42304 | 优惠已被另一商品的待支付订单锁定 |

原 `42200～42204` 不再作为低余额优惠错误码使用。客户端激活流程只接收 `code=0` 的有效响应，失败时不展示优惠，因此不需要修改分支判断。Portal 按新错误码处理校验和下单失败。

## 客户端接入事项

- 保留当前激活调用和响应类型；服务端发放的 `offerToken` 原样传入 Portal 定价页查询参数，不在 URL 中传递登录令牌、价格或折扣。
- 保留 `defaultTab=boost_pack` 到 Portal `tab=boost` 的映射，其余使用 `subscription`。
- 倒计时继续以服务端 `serverTimeEpochMs`、`expiresAtEpochMs` 和响应接收后的耗时计算；窗口重新聚焦时重新请求校时。
- 关闭状态继续按 `offerToken:windowCount` 区分，第二次窗口可以重新展示；同一优惠最多核销一笔成功订单。
- 当前客户端源码已经满足以上要求，本次仅同步文档。

## 发布顺序与注意事项

1. 测试库先执行服务端 `sql/V88__low_credit_purchase_offers.sql`；若曾按旧名称 V84 执行相同迁移，先核对结构，不要重复执行。此次迁移新增优惠表，以及 `payment_orders` 的优惠关联和价格快照字段。
2. 发布包含 `42300～42304` 的服务端 `dev-deploy` 版本，保持 Overmind `low-credit-purchase-offer` 活动关闭。
3. 发布同步错误码的 Portal 和已包含低余额优惠实现的 Electron 客户端。客户端本次没有运行代码变更，但实际发布版本必须包含原有功能提交。
4. 联调确认账号绑定、倒计时、商品范围、最终订单金额和普通购买流程后，再由运营按实际活动安排开启配置。

优惠到期后不能新建折扣订单；到期前已创建的订单继续按自身支付有效期和价格快照支付。更换 `campaignCode` 才会为用户提供新一期资格。合并代码不代表已执行数据库迁移、发布客户端或开启活动。
