# Android 微信月付接入：Electron 兼容说明

日期：2026-10-22。状态：配套服务端源码实施，尚未部署或完成真实渠道验收。

## 变更说明

服务端新增 Android 微信月付及升级入口，并复用官网个人订阅权益。Electron 无需接入微信 SDK、修改登录协议或改用 App 支付接口。桌面端继续通过原 Portal 入口完成购买/升级和订阅管理，同账号在 Android 购买并履约后，通过原额度及模型刷新流程读取新权益。

## 旧接口、认证与示例

现有 authCode 换取 JWT 双 Token、刷新和主进程 `fetchWithAuth` 行为保持。个人账号仍传 `Authorization: Bearer <accessToken>`；企业账号继续原上下文，不借 Android 购买入口切换权益。下列接口无新增请求体或必填参数，响应仍为 `{code,message,data}`，原字段类型及语义保持。

| 方法与路径/入口 | 请求 | 消费方式 |
|---|---|---|
| `GET /api/user/quota` | 原 JWT Bearer，无 body | 原套餐、额度、周期信息；App 已履约权益按共享 legacy 规则体现 |
| `GET /api/user/profile-summary` | 原 JWT Bearer、已有可选统计参数 | 原积分拆分与余额展示 |
| `GET /api/models/available` | 原 JWT Bearer、已有可选统计参数 | 原会员模型权限刷新 |
| Portal `/pricing`、`/profile` | 现有 `getPortalPricingUrl/getPortalProfileUrl` | 继续跳转官网下单、升级和管理，不向 URL 填入 App 签约参数或 Token |

请求示例：

```http
GET /api/user/quota
Authorization: Bearer <accessToken>
```

响应仍通过既有 `UserQuota` 和 profile-summary 类型消费；本次未增加 Electron 必须读取的新字段。服务端返回的已有 `subscriptionProvider` 等来源投影中，Android 仍属于 `legacy`，无需增加 `android` 权益类型。窗口重新聚焦或原额度刷新触发后，应读取服务端实际结果，不在本地依据付款提示加积分或推算周期。

## App 独立协议与消费端动作

新 `/api/payment/app/plans|quote|orders|subscription|management|cancel` 仅面向已验证的个人 access JWT，不能用 Cookie、refresh token、企业或 Admin 凭据调用。App DTO 中 ID 为不透明字符串、金额为整数分、积分为十进制字符串、时间为 UTC；`paymentScene`、`paymentStatus`、`fulfillmentStatus`、`cancellationStatus` 和 `upgradeFollowUp` 只在该新协议消费，不替换旧桌面类型。

Electron 本次仅增加此接入说明，不修改源码。保留既有 `auth.ts` 聚焦刷新、账号切换时丢弃过时响应的保护和 Portal 跳转。回归关注：同账号 Android 首购、官网月付升级至 App 月付后，原额度/模型刷新能反映服务端权益；其他设备未完成支付时，不自动重复购买；取消续费后当前已购周期仍可使用。实际购买与取消展示继续由原 Portal 契约处理。

## Admin 增量对本项目的影响

Admin 的原订单列表、用户订单行和退款预览新增可选 `appSubscription`（来源/操作、协议与履约状态、实际生效/到期、动作进度和 `requiresManualRefundAmount`）。该投影只供后台展示与人工退款确认，不新增本项目的请求字段，不改变原 Portal/Electron 的金额、权益或错误契约。本项目无需修改源码；继续既有购买和共享权益读取路径。

## 业务边界与服务端发布依赖

Android 仅新增微信按月自动续费购买及月付升级，不提供年付、加油包或支付宝新购。Web 与 Android 共用 `legacy` 个人订阅、积分和升级结算规则；渠道来源不同不产生两份同套餐权益。月付权益继续沿用官网的开通日期加 31 天、当日 23:59:59 到期规则，具体生效、到期及退款结果以服务端结算为准。普通月付续费核验并完成共同结算后，按官网规则立即更新周期和积分，不增加 App 待生效队列；不能仅根据签约成功或付款成功判定已经履约。

Apple 仍使用独立购买、交易和续费记录，并通过现有有效权益聚合读取。Apple 与 legacy 的购买占用双向互斥；已有 App 签约、扣款待核对、退款待核对、取消处理中不能因短期预约或任务租约到期而被忽略。这里的 `legacy` 包括 Web 和 Android；旧错误字段中的 `channel:"web"` 继续保留历史含义，客户端无需增加 `android` 枚举。

服务端发布顺序与条件：

1. 核对既有支付迁移已完成，再执行 `lobsterai-server/sql/V127__android_wechat_subscription.sql`。迁移兼容 MySQL 5.7，新增三张执行/签约/幂等表及原订单、协议的可空元数据字段；不得由前端或服务启动自动执行。
2. 所有共享该数据库的购买、Apple 入账/恢复、回调与任务实例先部署兼容版本。旧续费和预通知任务须跳过 `executionVersion=android_wechat_v1`，并识别持久占用；不能让不认识新协议的旧任务继续运行。只回滚到同样具备兼容桥接的版本。
3. 按服务端配置文档落实 AppID/商户绑定、已批准的 App 签约模板与扣费模式、证书/密钥、可信回调、稳定 state-key、序列号号段、条款及真实部署验收证明。模板能否复用 Web 以微信商户实际审批为准，不能由客户端推断。
4. `payment.app.wechat.enabled/new-purchases-enabled/worker-enabled/renewals-enabled` 默认均为 `true`。默认开启不表示配置和验收已满足；数据库结构及渠道 readiness 缺失时 App 不可购。需要暂停新购和升级时显式关闭 `new-purchases-enabled`，保留存量订单核对、履约、退款和解约处理。
5. 验证真实签约/首扣、重放与超时、续费、取消在途扣款、Web/App 交叉升级与 Apple 互斥后再开放 Android 购买入口。源码实现和静态检查不等于渠道验收；本次交付没有执行数据库迁移或真实支付。

Android 完整契约见 [服务端 API](../../../lobsterai-server/docs/api/android-subscription-api.md)、[移动端接入指南](../../../lobsterai-server/docs/integration/2026-10-21-android-wechat-monthly-subscription.md)及[设计文档](../../../lobsterai-server/docs/specs/payment/feature-2026-10-21-android-wechat-monthly-subscription.md)。手机源码不在本次变更范围。
