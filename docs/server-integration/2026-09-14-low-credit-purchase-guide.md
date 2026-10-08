# 低余额首充与返购优惠适配

日期：2026-09-14；成功付款资格口径更新于 2026-09-15。本说明更新此前低余额优惠合同中的首充商品范围、折扣与时效；接口路径和订单快照语义延续。资格纠正与待付订单边界见[2026-09-15 成功付款资格说明](2026-09-15-successful-payment-offer-eligibility.md)。

## 变更摘要

- 无历史成功个人订阅或加油包付款、个人可用积分不超过 100 时，首充优惠支持订阅 5 折或加油包 8 折，二选一共享一次核销，无倒计时。
- 成功个人付款仅包含同时满足 `payment_orders.status='paid'`、`paid_at IS NOT NULL`、`order_type IN ('subscription','boost_pack')`、`tob_enterprise_id IS NULL` 的订单。`refunding`、`refunded` 及其他非 `paid` 状态均排除，不能用当前订阅状态或仅有付款时间推断。
- 历史付费用户余额不超过 500 时的 9 折、30 分钟窗口规则保持原样。活跃订阅仅加油包适用，非活跃历史付费用户可选择订阅或加油包。
- 首个返购窗口尚未结束时积分耗尽，沿用同一截止时间；首个窗口结束后才耗尽，最多再开启一次窗口。总核销次数仍为一次。

- 原返购优惠未核销、没有待支付预约，且用户按新口径没有成功个人付款时，服务端在激活、查询及新建预约校验中重新判定；实时余额不超过 100 时纠正为订阅 5 折／加油包 8 折的不限时首充，超过 100 不授予首充。已有 `pending` 订单保持原价格快照、有效期和锁；`redeemed` 不恢复。

## 接口与响应

`POST /api/purchase-offers/low-credit/activate` 无请求体；`GET /api/purchase-offers/current?offerToken=<token>` 校验已有优惠。Portal 使用现有 Cookie/Session 或 Bearer 登录态，Electron 使用 JWT Bearer。优惠令牌不替代登录，也不能指定折扣或价格。

首充响应的关键字段示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "status": "active",
    "offerToken": "<server-issued-token>",
    "offerType": "first_purchase",
    "discountRate": 0.5,
    "productDiscountRates": { "subscription": 0.5, "boost_pack": 0.8 },
    "eligibleProducts": ["subscription", "boost_pack"],
    "defaultTab": "subscription",
    "hasEverPaidPersonalOrder": false,
    "creditsRemaining": 99.81,
    "serverTimeEpochMs": 1789372800000,
    "expiresAtEpochMs": null
  }
}
```

`productDiscountRates` 是按适用商品返回的部分映射；返购各适用商品为 `0.9`。`discountRate` 保留兼容旧消费者，不能用它代替新映射中的商品折扣。`creditsRemaining` 反映接口读取时的个人可用积分。`hasEverPaidPersonalOrder` 保留字段名兼容，语义为当前存在上述符合条件的成功个人付款订单，不再表示任一状态的曾经付款。

仅 `offerType="first_purchase"` 且 `expiresAtEpochMs` **显式为 null** 表示无限期；字段缺失不表示无限期。返购继续基于服务端时间和截止时间显示倒计时，聚焦或恢复页面后重新校验。

下单请求保持原样：

- `POST /api/subscription/create`：`{"planId":2,"paymentChannel":"unified","offerToken":"<token>"}`。
- `POST /api/boost-packs/purchase`：`{"boostPackId":1,"paymentChannel":"unified","offerToken":"<token>"}`；自定义加油包用 `"amount":100` 替代 `boostPackId`。
- 订单返回 `amount`（实付）、`originalAmount`（原价）、`discountRate`（订单折扣），例如 100 元首充加油包返回 `80 / 100 / 0.8`；基础积分仍按 100 元面额发放。

## Portal 适配

- 套餐卡片、预设/自定义加油包、购买摘要和支付弹窗按各自商品折扣计算预览；首充提示为“首充福利”，不展示限时文案或优惠倒计时。
- `eligibleProducts` 与对应商品折扣同时有效才显示该商品优惠并携带令牌；收到新映射时不对缺失商品回退全局折扣。
- 旧服务响应没有映射时，仅对 `eligibleProducts` 中的商品使用旧 `discountRate`；旧首充加油包不沿用订阅 5 折，也不自行猜测 8 折。
- 支付弹窗已有订单优先读价格快照，打开时固定本次商品令牌和折扣；优惠状态变化不重算已创建订单价格。订阅后续自动续费仍为套餐原价。
- 首充二选一受服务端共享优惠记录和核销约束；不同商品的待支付订单冲突继续返回 `42304`。其他现行错误码 `42300–42303` 保持不变。

## 发布与验证边界

本功能尚未上线，无生产存量优惠数据，不需要数据 UPDATE。2026-09-15 资格修正通过服务端业务入口处理，不新增结构或迁移脚本。发布时先完成 V88、V89 数据库结构准备，再发布服务端、Portal 和桌面客户端，最后按活动安排启用优惠；首次创建优惠即采用新规则。在线活动开关和配置修改另行执行，不属于前端适配。生产发布前核对首充两个商品价格、旧接口兼容、返购倒计时、账号不匹配，以及已有订单快照；本次本地验证仅执行 lint 和 build，不启动浏览器或 dev server。

## Electron 适配与展示规则

- 使用 `productDiscountRates` 按商品展示和携带同一 `offerToken`；首充左侧“8折充值积分”打开 `tab=boost`，右侧“5折升级套餐”打开 `tab=subscription`。普通入口不携带无效优惠。
- `expiresAtEpochMs: null` 仅对首充表示不限时；首充卡和任务内提示不展示倒计时。返购卡和任务内提示共用服务端时钟，窗口内归零不重置时间，窗口二由服务端决定。
- 左下角首充、返购和普通低余额引导与版本更新卡片共用侧栏底部 `px-3 pt-1.5` 容器，卡片使用 `w-full`，宽度随侧栏拖动和应用缩放自然调整，高度按内容排版。取消独立固定宽度、`document.body` Portal 和坐标测量，避免卡片超出侧栏；保留侧栏原有收起行为。
- 卡片采用紧凑白底、圆角和柔和阴影，压缩标题、说明、进度条及按钮之间的留白。有效返购在按钮上方单独展示渐变“限时9折”与红色数字块，倒计时为 `MM:ss.s`；组件按服务端时钟每 100ms 刷新数字，父级按截止时间一次性更新优惠有效状态。首充仍不计时。
- 左下角付费引导优先于版本更新和 banner。其他组件隐藏时保留原状态；关闭付费卡后恢复原有“展开更新卡优先，其余情况 banner”的关系。任务内积分耗尽提示独立存在，不受左下角关闭操作影响。
- 关闭状态由 `ownerAccountKey` 隔离，保存在现有 `localStore`。优惠关闭键为活动、token、windowCount，不含triggerStage，因此同一窗口从低余额变0不重弹；新的第二窗口可提醒。
- 普通提醒只面向历史个人付费用户，总余额≤500时按low/exhausted两个阶段记录关闭。余额先恢复到500以上、之后再下降才进入新轮次。关闭优惠同时记录当时普通阶段，防止过期后同阶段立即重弹。
- 金额读取优惠接口实时 `creditsRemaining`；`auth.quota.creditsRemaining` 不包含完整积分来源，`hasPaidCredits` 也不是历史付款证据，不用于该引导判定。优惠接口失败时不伪造0余额或新优惠。
- 测试用户 13699 的旧 0.10 元付款记录不能单独证明返购资格；需按当前 `status=paid`、`paid_at` 非空及个人订阅／加油包范围重新判定。若仅有非 `paid` 订单，应按无成功个人付款及实时余额条件验收首充，不能沿用旧账号分类。
- 任务徽章使用由路径、圆形和渐变组成的纯矢量 SVG，不内嵌 PNG；保留圆章、星星和飘带造型，并在组件中叠加中英文文案。

## 倒计时缺失排查

“限时折扣＋倒计时”整行仅在有效返购优惠且存在适用商品折扣时渲染。服务端返回失效、已核销、未启用等状态时，历史付费账号余额不超过 500 会显示普通引导，普通引导不包含倒计时；这与 CSS 隐藏不同。

返购窗口已结束但余额仍为 199 等正数时，重复激活不会重发 30 分钟。只有符合既有规则的积分耗尽阶段才可开启第二窗口；不能通过客户端补写截止时间、重置优惠或修改数据来制造倒计时。检查时需要核对 `status`、`reason`、`offerType`、`windowCount`、`expiresAtEpochMs`、`serverTimeEpochMs` 和适用商品折扣。本轮已确认本机为测试账号 13699，未发现本地关闭记录；测试库连接失败，未将历史优惠记录当作当前状态证明。
