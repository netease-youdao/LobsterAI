# 个人优惠订单换购接入（2026-09-16）

## Change Summary

Server 新增报价、幂等换购与进度接口，修复先打开一种商品的支付弹窗再购买另一种商品时优惠被 pending 占用的问题。关闭弹窗只隐藏，不取消订单。换购不延长原优惠倒计时。

## Endpoint Details

- `POST /api/payment/quote`：`{offerToken?,target}`。只读报价，返回 amount、originalAmount、discountRate、baseCredits、bonusCredits、totalCredits、creditsEstimated、serverTimeEpochMs；为兼容旧版 Portal，额外固定返回 `replacementEnabled=true`，不再对应配置开关。
- `POST /api/payment/orders/{oldOrderNo}/replace`：`{requestId,offerToken,target}`。requestId 为同一用户唯一 UUID，重试必须复用。
- `GET /api/payment/order-replacements/{requestId}`：返回 processing / completed / old_order_paid / offer_unavailable，completed 包含 order 支付信息和订单状态。
- 原下单接口不变。42304 错误的 data 包含 currentOrderNo/currentProductKey 与订单时间字段。
- 创建与查询订单新增 serverTimeEpochMs、orderExpiresAtEpochMs、paymentProcessing；只用服务端绝对期限计算剩余时间，不在刷新二维码时重置 30 分钟。

请求示例：

```json
{"requestId":"550e8400-e29b-41d4-a716-446655440000","offerToken":"当前用户的优惠 token","target":{"orderType":"boost_pack","amount":100}}
```

目标三选一：subscription + planId；boost_pack + boostPackId；boost_pack + amount（整数 10～5000）。禁止传客户端价格/折扣/积分。响应统一 ApiResponse `{code,message,data}`。

## Frontend Action Items

1. 用户选择时先 quote 展示实际金额、基础积分和预计赠送积分。门槛按折后实付金额，最终赠送按实际支付时活动规则。
2. 显式选择遇到携带 currentOrderNo 的 42304，且持有当前优惠 token 时，仅发起一次换购；不再检查 quote.replacementEnabled，不要递归处理新冲突取消别的标签页的新订单。
3. 保存 requestId 及原目标，处理中隐藏旧二维码，轮询进度。超时/重新打开继续同请求；关闭页面不取消后台操作。
4. completed 使用返回的新支付参数；old_order_paid 刷新账户/优惠并让用户重新选择；offer_unavailable 明确提示，不自动原价购买。
5. 订单显示 payment_review 时提示已收款待核对，不再展示可支付二维码。服务端留有交易凭证供对账。

## Auth Requirements

Cookie/Session 或 JWT Bearer；JSON Content-Type。服务端校验订单和 offerToken 归属，进度仅返回当前用户的请求。查询接口不要放到公开页面匿名调用。

## Notes & Caveats

必须先应用 V90 DDL，部署全部服务端节点，最后发布 Portal。换购、换购恢复与个人订单超时清理始终可用，无需配置文件或环境变量启用，遗留开关配置不再生效。无需历史数据 UPDATE。旧数据库的 NULL flow 不代表未扫码。

2026-09-16 用户 14189 在 50 元切换 100 元商品时，虽然新商品已选中，但旧开关关闭导致前端未调用换购接口。现已删除该开关及 Portal 的条件判断；旧 Portal 通过固定 true 的兼容字段继续工作。服务端 42304 提示改为先处理原订单或等待关闭。发布后验证 50 元到 100 元的换购；仍需先查单、确认关单再释放优惠。接口签名、结构和鉴权方式不变。

订单支付时限与优惠时限独立，已签发订单按价格快照付款；换购不能重置优惠期限。渠道关单/扣款状态未知时 pending 可超过 30 分钟，前端展示处理中。微信代扣关单可能受最短时间限制；已发出的支付宝 WAP 链接查无订单时需等待到期或取得明确关闭证明。

完整实现及发布验收说明：`lobsterai-server/docs/2026-09-16-pending-order-replacement.md`。

Electron 当前继续打开 Portal 支付页，无需新增本地关单操作；原付费悬浮窗优先级和用户关闭状态保持原业务规则。
