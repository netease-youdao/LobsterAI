# iOS 订阅单渠道互斥：Electron 接入说明

## 变更摘要

个人订阅在 Web 与 Apple 之间互斥：原渠道取消订阅成功且已付费权益到期后，才能到另一渠道购买。取消自动续订但权益未到期时，用户仍使用当前渠道管理。Web 渠道内部的订阅、升级及续费逻辑继续保留。

Apple 订阅点击桌面“升级”仍展示“当前订阅由 Apple 管理，请前往 Apple 升级套餐。”，由用户选择前往固定官方管理入口 `https://apps.apple.com/account/subscriptions`。无需增加取消订阅提示。套餐映射与启售不再要求管理员手工配置权益等级，桌面也不维护套餐等级表。

## 当前消费路径

桌面通过现有 `GET /api/user/quota`、`GET /api/user/profile-summary` 获取服务端确认的会员和余额，沿用当前 Electron JWT、请求头、身份上下文及刷新逻辑。已有 `subscriptionProvider`、`hasAppleSubscription` 等可选字段继续兼容旧服务端。

已检索当前源码：Electron 不调用个人订阅下单或订单状态轮询接口；普通 Web 支付跳转 Portal 处理。故本轮无需新增桌面源码、IPC、认证或支付逻辑。桌面从 Portal/Apple 返回后只能通过服务端刷新确认权益，不能因为浏览器页面打开或关闭就推定开通成功。

## 支付状态新增字段

供未来接入订单状态的桌面功能及 Portal 对接参考，以下原接口新增可选字段：

- `GET /api/payment/orders/{orderNo}/status`：保留服务端原登录/订单归属校验。
- `GET /api/payment/unified/orders/{orderNo}/status`：保留统一支付公开订单查询契约。

无请求体；实际 HTTP 请求仍由 Portal 发起。响应例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "orderNo": "<原订单号>",
    "status": "paid",
    "fulfillmentStatus": "needs_support",
    "supportReference": "<支持编号>"
  }
}
```

`paid` 表示实际收款，不等同于权益已交付。若 `fulfillmentStatus=needs_support`，消费端必须停止成功处理，显示“付款已收到，订阅开通需要人工处理，请联系客服。”及可选支持编号，不自动重新购买。`fulfillmentStatus=granted` 或省略字段时保留原行为。Portal 已适配这两个支付完成入口；Electron 本轮无直接消费点。

## 前端事项与兼容性

1. 保留已有 Apple 升级引导、非 Apple 用户的 Portal 跳转及加油包入口。
2. 由服务端确认渠道状态，客户端不通过 `autoRenew=false` 独自判断可切换渠道。
3. `mixed` 等历史兼容字段仍可用于异常识别，不能解释为允许用户同时订阅两个渠道。
4. 不新增 Token 存储或认证回退，不读取 `.p8`，不在桌面发起 StoreKit 购买。

本项目本轮只有接入文档更新，没有源码变化，因此未重复运行 Electron 类型检查或测试。Portal 已完成定向类型检查、lint 和支付完成回归测试；服务端测试按项目约定未执行。上线需要服务端和 Portal 配套部署，桌面无需因本次规则调整强制升级。
