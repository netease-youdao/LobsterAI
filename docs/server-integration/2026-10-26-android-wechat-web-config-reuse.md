# Android 微信订阅复用 Web 配置接入说明

日期：2026-10-26。适用：Portal、Electron 及 Android 接入协作。此次为服务端配置调整，Portal/Electron 无需修改代码或同步发布。

## 1. Change Summary — 变更摘要

Android 微信订阅默认复用同商户 Web Overmind `wechat-pay-config` 中的商户凭据、订阅模板 ID 和签约/代扣回调。在 Web 配置完整、JWT 密钥有效且使用 prod/test/local Spring profile 的情况下，正常部署仅新增 `APP_WECHAT_APP_ID`；环境自动获取，条款使用 Web 默认地址，状态密钥从现有 JWT 密钥派生。人工部署、兼容、号段及 App 授权证明配置已删除。

没有新增或修改 HTTP 接口路径、请求/响应字段、类型、错误码或认证规则；没有新增数据库迁移。服务端设计见[配置复用方案](../../../lobsterai-server/docs/specs/payment/feature-2026-10-26-android-wechat-web-config-reuse.md)，App 完整契约见[Android 订阅 API](../../../lobsterai-server/docs/api/android-subscription-api.md)。

## 2. Endpoint Details — 接口与示例

现有 Portal `/api/subscription/**`、`/api/payment/orders/**` 以及 Electron 登录、代理、权益接口继续使用原协议，不需要改为 Android 支付路径。

Android 接入继续使用原接口，例如：

```http
POST /api/payment/app/quote
Authorization: Bearer <个人 accessToken>
Content-Type: application/json
```

请求体不增加任何商户或配置字段：

```json
{"planId":"3","billingPeriod":"monthly","paymentChannel":"wechat"}
```

成功且可购的格式示例（值仅为示意，不代表线上价格或真实报价令牌）：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "quoteId": "quote_example_01",
    "operation": "purchase",
    "planId": "3",
    "billingPeriod": "monthly",
    "paymentChannel": "wechat",
    "paymentScene": "android_app",
    "firstChargeAmountFen": 9900,
    "renewalAmountFen": 9900,
    "currency": "CNY",
    "credits": {"base":"10000.000000","bonus":"0.000000"},
    "upgradeSettlement": null,
    "termsVersion": "android-wechat-monthly-v1",
    "termsUrl": "https://c.youdao.com/dict/hardware/lobsterai/subscription.html",
    "purchasable": true,
    "unavailableReason": null,
    "expiresAt": "2026-10-26T02:05:00Z",
    "serverTime": "2026-10-26T02:00:00Z"
  }
}
```

运行配置、模板或结构不满足条件时仍按既有契约展示不可购及 `channel_not_ready` 等原因。微信侧权限仍需实际开通，但服务端不再要求填写人工授权证明字符串。

## 3. Frontend Action Items — 前端事项

- Portal、Electron：无需新增配置、请求参数或界面分支，继续使用原接口及服务端返回的权益/订单状态。
- Android：继续消费服务端目录、报价和 SDK action。不得由客户端指定 AppID、商户号、微信模板、密钥或扣费模式，也不在 SDK 返回后自行认定已付款。
- 联调时核对同一用户在各端的订阅、额度及取消状态一致；共享配置不改变既有支付占用与升级限制。

## 4. Auth Requirements — 认证要求

Portal 保持原 Cookie/Session 认证，Electron 保持原 JWT 认证。Android `/api/payment/app/**` 业务接口继续要求有效个人 JWT access token，Bearer 无效时不回退 Cookie。

微信签约/代扣回调使用渠道验签及本地协议身份核对，不使用客户端 JWT。回调可继承 Web 的旧通知地址，也可由运维显式配置 App 专用通知地址；客户端不参与此选择。

## 5. Notes & Caveats — 部署与兼容

- 正常新增配置只有 `APP_WECHAT_APP_ID`。profile 的 `reuse-web-config` 在 Java 中默认 true，不需要额外设置环境变量；高级显式 profile 配置继续覆盖继承值。四个购买/任务功能开关默认 true。旧配置版本、复用开关、商户凭据、回调及续费模式环境变量仍作为兼容覆盖识别，不要求新部署重复填写。TTL、条款等使用 Java 默认值，必要时通过标准属性覆盖。
- 共享凭据只限同商户；AppID 不继承 Web AppID。Web `apiKey` 必须是实际 V2 密钥，Android 不使用 `apiV3Key` 代替。
- 模板默认按服务端 `Plan.name` 读取 Web `papayPlanIds`，再回退 `papayPlanId`；无需重复填写 Android 模板 ID。已有 `templates[本地套餐ID]` 可显式覆盖。续费模式默认 `pre_notify`，与 Web 当前预扣通知流程一致；可选共享 `papayRenewalMode` 可覆盖。移动应用与商户关联及模板 App 签约权限仍需在微信侧完成，原有升级模板冲突检查继续生效。
- 环境由 Spring profile 获取；prod/test/local 自动选择各自流水号基数，自定义环境需显式设置不重叠基数。旧的完整 `payment.app.wechat.environment` 属性可保留但其值被忽略，不阻止绑定启动。原手填环境与 profile 不一致时，Android 重新获取报价和管理令牌；已有业务订单和协议保持原身份。
- 新部署无需新增状态密钥；已有部署若设置过 `APP_WECHAT_STATE_KEY`，必须继续保留原值以解密旧会话。新部署使用的 JWT 密钥也须在同环境实例间一致且稳定，轮换会影响签约会话和令牌。已有 `APP_WECHAT_REQUEST_SERIAL_BASE` 继续作为兼容覆盖。
- 原有回调路径已有 App 分发能力；所有相关回调、定时任务及服务实例必须先完成兼容部署，之后再放行新 App 协议。
- 历史协议保留原身份和 profile。切换商户、移动应用或续费模式时保留旧 profile，供历史回调、解约及退款使用。
- 此次不增加 DDL；Android 已有的数据库结构要求及渠道验收要求不变。未因为生成本文而部署服务、修改线上配置或执行真实支付。
- 2026-10-26 使用 JDK 17 执行 `./gradlew compileJava compileTestJava verifyMybatisMappings -x test --offline --no-daemon` 成功；主代码和测试源码通过编译，Mapper 元数据静态检查通过。按仓库约定未运行服务端测试，也未执行 SQL 或渠道联调。
