# Android 订阅加固：Electron 兼容指南（2026-10-26）

## 变更摘要

Android微信仍是legacy订阅，paymentScene=android_app只是渠道场景。旧Electron订阅、下单、查单和取消端点、认证、字段类型继续保留。本次没有修改Electron源码。服务端异步管理及权益事实修复已实施；桌面目前经Portal处理购买与管理，Portal页面同时接入新能力。

## 接口与可选字段

`GET /api/subscription/management` 保留原webManagement/appleManagement，可选增加agreementManagement（preciseCancellationSupported、items、partial、serverTime）。支持时，针对用户选中的managementId可调用 `POST /api/subscription/management/cancel`：

```json
{"managementId":"opaque-token","requestId":"7c3be37e-fd4c-4128-814c-30102f53e99c"}
```

返回data.item.cancellationStatus=pending|confirmed|failed|none；HTTP200仅表示取消意图持久化，confirmed才是渠道确认。缺能力字段时继续原管理入口；不能在精确操作失败后自动调用旧批量取消。

App订单经旧私有查单时保留status=paid；仅实际fulfillmentStatus=granted才返回subscriptionStatus=active。未交付或已撤回时省略subscriptionStatus。可选fulfillmentStatus、effectiveAt、supportReference、nextPollAfterMs分别表达权益与后续处理；需直接处理新场景的未来桌面UI应识别这些字段，显式未知状态不得默认成功。当前权益仍以GET /api/subscription为准。

## 认证

现有JWT access/refresh流程不变。新精确取消允许有效个人JWT access token；携带无效Bearer不回退Cookie，企业token拒绝。纯JWT无Origin可用；有Origin必须在server可信列表。Cookie浏览器由Portal使用，其写请求要求可信Origin。正文UTF-8 JSON最多8KiB，requestId为UUID，重试同ID同参数。

## 发布、注意事项与验收

先服务端兼容发布，再发布Portal；Electron无需同步升级。应用不得缓存或记录短期SDK签约参数，预签约过期不能靠换requestId创建新会话；原订单只读跟踪。renewal订单不可创建SDK action或取消购买，需从management取消续费协议。

交叉验收：旧Electron在新server查询Web/Android/Apple权益；Portal登录深链保持；取消受理不显示最终关闭；付款与履约分离；历史Web月付转Android升级使用稳定已履约证明。当前未运行Electron构建，桌面源码未变；不包含手机App源码实施或渠道验收。
