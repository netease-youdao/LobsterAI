# 低余额优惠：成功付款资格口径修正

日期：2026-09-15。本文补充 [首充与返购适配说明](2026-09-14-low-credit-purchase-guide.md)，覆盖此前“仅按付款时间判断、退款仍计入历史付费”的旧口径。接口字段与前端展示逻辑不新增；本次说明不代表代码已发布或数据库已变更。

## 变更摘要

`hasEverPaidPersonalOrder` 保留原字段名兼容，改为表示当前是否存在同时满足以下条件的订单：

```sql
payment_orders.status = 'paid'
AND payment_orders.paid_at IS NOT NULL
AND payment_orders.order_type IN ('subscription', 'boost_pack')
AND payment_orders.tob_enterprise_id IS NULL
```

`refunding`、`refunded` 以及其他所有非 `paid` 状态均不计入；`paid` 但付款时间为空也不计入。企业订单排除。只要仍有其他符合条件的个人订单，就仍是已付费用户。当前套餐、已过期订阅、赠送积分和曾经写入的付款时间均不能替代该判断。

无符合条件的成功个人付款、个人可用积分不超过 100 时，首充为订阅 5 折／加油包 8 折二选一共享一次，不限时。存在符合条件的成功个人付款时，返购 9 折、500 积分阈值和原有 30 分钟窗口规则延续。

## 接口与认证

请求和认证均保持不变：Portal 使用现有 Cookie/Session 或 Bearer 登录身份，Electron 使用 `Authorization: Bearer <accessToken>`。优惠令牌只用于定位优惠，不能替代身份认证，客户端不能提交资格、折扣或最终价格。

| 方法 | 路径 | 请求 |
|---|---|---|
| POST | `/api/purchase-offers/low-credit/activate` | 无请求体 |
| GET | `/api/purchase-offers/current?offerToken=<token>` | 查询参数传当前账号的优惠令牌 |
| POST | `/api/subscription/create` | `{"planId":2,"paymentChannel":"unified","offerToken":"<token>"}` |
| POST | `/api/boost-packs/purchase` | `{"boostPackId":1,"paymentChannel":"unified","offerToken":"<token>"}`；自定义面额用 `"amount":100` 替换 `boostPackId` |

无成功个人付款且余额不超过 100、满足首充授予条件时，激活或查询响应关键字段如下（字段节选，令牌仅为示例）：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "status": "active",
    "reason": null,
    "offerToken": "<server-issued-token>",
    "offerType": "first_purchase",
    "hasEverPaidPersonalOrder": false,
    "creditsRemaining": 99.81,
    "thresholdCredits": 100,
    "discountRate": 0.5,
    "productDiscountRates": { "subscription": 0.5, "boost_pack": 0.8 },
    "eligibleProducts": ["subscription", "boost_pack"],
    "defaultTab": "subscription",
    "expiresAtEpochMs": null
  }
}
```

`hasEverPaidPersonalOrder=false` 仅表示没有符合该口径的订单，不保证一定存在可用优惠；还需服务端校验活动、账号、实时余额、核销与预约状态。只有 `active + first_purchase + expiresAtEpochMs === null` 才按不限时首充展示。

## 旧返购与订单边界

服务端在 `activate`、`current` 和新建订单预约校验时重新检查资格：

| 情况 | 处理 |
|---|---|
| 原返购优惠未核销、无待支付预约；按新口径没有成功个人付款；实时余额不超过 100 | 保留原优惠 ID 和 token，按首充资格纠正为订阅 5 折／加油包 8 折、共享一次、无倒计时，不继续使用原返购截止时间 |
| 同上，但实时余额超过 100 | 不授予首充；不能因曾有返购记录绕过首充余额阈值 |
| 已有关联 `pending` 订单 | 保留原 `amount`、`originalAmount`、`discountRate`、订单支付有效期及商品预约锁，不重新定价或切换商品 |
| 已有优惠为 `redeemed` | 不恢复优惠；其核销订单进入退款状态也不恢复一次性额度 |
| 仍有任一符合条件的成功个人付款 | 继续按返购规则处理 |

失败或关闭订单仍按既有流程释放预约；之后的新建预约重新校验当前资格。纠正旧返购不会新增同活动核销次数，也不会更改已创建订单的价格。`GET current` 可能更新优惠状态，不能作为只读数据库排查的替代入口。

## 前端事项

- 本次不增加前端逻辑。沿用 `hasEverPaidPersonalOrder`、`offerType`、`status`、`eligibleProducts`、`productDiscountRates` 和实时 `creditsRemaining`，不要在前端根据退款状态、当前订阅或测试账号 ID 再次推断资格。
- 服务端纠正后按返回商品折扣展示首充：订阅 5 折、加油包 8 折；不保留返购倒计时。字段缺失或返购的空截止时间不能按无限期处理。
- 已有待支付订单始终优先显示订单价格快照；仍可按原订单有效期支付。不同商品待付预约冲突继续使用 `42304`；现行错误码 `42300–42303` 不变。
- 测试账号 13699 不能仅凭旧 0.10 元付款记录固定归类为返购。账号分类需按当前订单状态、付款时间及个人订单范围确定，首充是否展示还取决于实时余额和优惠状态。

## 发布与验收边界

不新增 UPDATE SQL、数据回填或迁移脚本。本功能首次上线仍只需既有 V88/V89 结构准备；本次资格纠正由服务端业务入口执行，不修改在线活动配置，也不要求改写已有订单。当前说明不声称已部署，服务端构建结果另行记录。

实现验收应覆盖：`paid` 且有付款时间、`paid` 但无付款时间、仅 `refunding`／`refunded`／其他非 `paid`、企业订单、同时存在退款订单和另一笔有效 `paid` 订单；以及余额 100／大于 100、旧返购无预约纠正、已有 `pending` 价格及锁不变、`redeemed` 不恢复。前端本轮仅文档同步，不启动浏览器、dev server 或额外前端测试。
