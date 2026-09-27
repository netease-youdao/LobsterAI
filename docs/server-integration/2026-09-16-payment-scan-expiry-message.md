# 支付扫码页过期提示调整

## Change Summary

统一扫码页对已关闭订单按关闭原因展示提示，移除直接面向用户展示 `closed` 等内部状态的文案。二维码仍为 `pending` 但已过期时，使用相同的过期提示。

## Endpoint Details

- `GET /api/payment/unified/route/{orderNo}`
- 兼容入口：`GET /api/payment/unified/route?orderNo={orderNo}`
- 请求无 body，`User-Agent` 继续用于识别微信或支付宝。响应为 `text/html`，不是 JSON。
- 已关闭的加油包过期订单示例：HTTP 200，正文为 `<h2>支付异常</h2><p>订单已过期，请重新购买加油包</p>`。
- 尚未关闭的过期个人订单继续返回 HTTP 410，同样显示上述提示。
- 订阅过期提示“订单已过期，请重新发起订阅”；换购关闭提示“已切换商品，原订单已关闭，请使用新二维码支付”。

## Frontend Action Items

调用方式和二维码内容无需调整。更新服务端后，已发出的统一路由二维码使用新的状态提示。

## Auth Requirements

扫码入口继续公开访问，无需 Cookie 或 JWT。支付状态和可支付性仍由服务端决定。

## Notes & Caveats

- 优先使用 `close_reason=expired/replacement`。缺少关闭原因的历史个人订单，仅在原有效期已结束时显示过期。
- 已付款、支付失败及有其他明确关闭原因的订单不按过期处理；扫码不重新激活旧订单，也不创建新支付。
- 无 API 字段变更，无配置开关，无数据库变更。本次仅修改服务器生成的扫码提示页，未增加返回按钮。

