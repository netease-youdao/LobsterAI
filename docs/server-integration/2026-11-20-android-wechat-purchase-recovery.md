# Android 微信签约返回与订单恢复

2026-11-20。供 Android 支付接入及 Electron 权益联调使用。此次调整个人 JWT 下的 Android 月付订单接口。Electron 用户继续在 Portal 购买，桌面端沿用现有的订阅状态与额度查询。

## 安卓返回购买页

用户关闭微信页面或回到 App 后，使用同一账号的个人 access token 查询原订单。只有用户明确点“放弃购买”时才提交取消。涉及的接口均位于 `/api/payment/app`，业务请求头为 `Authorization: Bearer <accessToken>`。下表的请求体以 JSON 发送，省略请求体的查询使用 GET。

| 方法与路径 | 请求体示例 | 使用时机 |
|---|---|---|
| `GET /orders/{orderNo}` | 无 | 展示签约、收款、履约与取消状态 |
| `POST /orders/{orderNo}/action` | `{"requestId":"2e966f3b-e9b2-4cb4-902c-a9032ac96073"}` | 用户选择继续，且服务端允许原单准备签约 |
| `POST /orders/{orderNo}/cancel` | `{"requestId":"335ee48b-1aa4-44a7-910f-c4fed77a1b86"}` | 用户明确放弃原未完成购买 |
| `GET /plans` 或 `GET /subscription` | 无 | 进入套餐页匹配待处理的原单，或在原单关闭后刷新购买与升级资格 |

套餐页先看 `purchaseEligibility.pendingPurchase`。其中的 `planId` 是原订单的目标套餐 ID（字符串）。旧服务端缺少该字段时，用 `orderNo` 查原单详情取得 `planId`。即使新购资格返回 `purchasable=false`，仍可按下表恢复原单。

| 用户操作 | Android 处理 |
|---|---|
| 选中原套餐，`canPrepareSign=true`，点击继续 | 对原订单调用 action，使用本次点击的新 `requestId`。同一次点击发生网络重试时沿用这个 ID |
| 原单已过期或正在取消，或改选其他套餐，目标档位 `canReplacePendingPurchase=true` | 以原单 `operation` 和 `replaceOrderNo` 请求目标档位的报价。用户确认目标价格和条款后，用该报价创建新订单 |
| 其他未完成状态 | 展示原单的签约、首扣、履约或关单进度，保留选中的套餐 |
| 跨设备、丢失记录，或缓存的 A 返回 `purchaseReplaced=true` | 刷新 `/plans` 和 `/subscription`，按同一账号当前的 `pendingPurchase.orderNo` 或已生效的权益恢复。A 若有实际收款或客服编号，保留对应信息 |

换购沿用相同的个人 JWT。示例中的 A 是未完成的购买，目标 B 的套餐 ID 为 `4`。

```http
POST /api/payment/app/quote
Authorization: Bearer <accessToken>
Content-Type: application/json

{"planId":"4","billingPeriod":"monthly","paymentChannel":"wechat","operation":"purchase","replaceOrderNo":"LBEXAMPLE202610210001"}
```

`data.purchasable=true` 的换购报价回显原单号。展示返回的首期、续费价格与条款，确认后提交 `POST /api/payment/app/orders`，请求体仍为 `{"quoteId":"<本次换购报价>","requestId":"<本次确认的 UUID>","termsVersion":"<报价中的版本>","agreementAccepted":true}`。报价期间 A 仍可继续。创建成功后保存 `data.orderNo`，对新单请求 action。网络超时用同一请求体重放。确认时若旧单已签、首扣在途或查证失败，刷新原单进度，待资格恢复后回到用户选择的套餐。

首次拉起窗口默认 90 秒。窗口内，action 可返回原会话及原截止时间。窗口已过且业务订单仍有效时，新一次 action 查原商户协议，微信确认尚无协议且服务端确认没有签约、首扣提交或取消事实后，在同一业务订单和同一协议上重新预签约。客户端仅在收到 `ready` 后，使用本次返回的参数及 `firstLaunchBefore` 立即拉起微信。旧签发请求重放可返回 `410/40503/action_expired`，丢弃旧参数并读取原订单。[微信支付原单重试说明](https://pay.wechatpay.cn/doc/v2/merchant/4011987907)

微信仍在签约或查约结果未知时，action 可返回以下结果。手机按订单的 `nextPollAfterMs` 查证进度。已经签约或提交首扣的订单继续展示原单收款和交付结果。

```json
{"code":0,"message":"success","data":{"actionStatus":"processing","paymentAction":null,"serverTime":"2026-11-20T02:02:01Z"}}
```

用户明确放弃或未签约的业务订单到期后，服务端进入关单。签约凭据可能仍有效，`cancellationReason` 给出等待原因，`signSessionExpiresAt` 表示原协议全部预签约会话中最晚的预计到期时间，包含后续重试已替换的会话。签发结果未知时，按该会话创建时间加 2 小时估算。服务端在最晚预计到期时间后另加 1 分钟传输余量。此后新发起的查约确认原合同不存在且排除在途首扣，才可按未签约关闭原单并释放购买资格。

已受理放弃并进入关单后，若首扣真实到账，订单会返回 `cancellationStatus=failed`。展示实际收款及权益交付进度，交付完成后结束本单的取消轮询。未来续费的解约进度查看 `GET /api/payment/app/management`。未请求放弃的正常已付款订单返回 `cancellationStatus=none`。

关单待客服核对时可以同时收到 `cancellationReason=needs_support`、`fulfillmentStatus=not_granted` 和原协议下最晚的会话预计到期时间。手机展示原订单及客服参考号，按 `nextPollAfterMs` 控制自动查询。重新进入页面或手动刷新时，重新获取订单及购买资格。

## 跨端联调

原订单还在核对时，Portal 或桌面购买入口可能显示已有订阅支付正在处理。签约、首扣、履约与退款分开展示。桌面端在窗口重新聚焦时刷新服务端权益和额度。此次接口调整无需同步发布 Electron 或修改 Portal 的二维码流程。测试服部署兼容服务端后按以下步骤联调。

1. 选择标准套餐拉起微信，直接返回 App。分别在 90 秒内和之后点击同档，抓取原单 action，验证同一个 `orderNo`、相同商户协议号。完成签约后核对一次首扣、一次权益交付及同账号桌面端权益刷新。
2. 浏览 B 后返回 A，验证 A 可继续；再次选 B 并确认，验证换购只创建一个 B。另一设备通过套餐列表恢复 B，A 的迟到签约只解约 A，最终只有 B 扣一次、交付一次。对明确放弃或过期的未付 A 再验证同档重购。
3. 分别覆盖微信仍在签约、查约超时、首扣已提交以及取消后迟到签约回调。客户端展示原单对应进度，同一订单只交付一次。

先部署全部兼容的服务端与支付 worker，再发布使用此能力的手机端。旧服务端未返回目标档位的换购能力时，手机沿用原单恢复流程。

完整字段和错误码见[服务端接口契约](../../../lobsterai-server/docs/api/android-subscription-api.md)。手机交互见[安卓接入指南](../../../lobsterai-server/docs/integration/2026-10-21-android-wechat-monthly-subscription.md)。
