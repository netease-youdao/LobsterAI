# 2026-09-17 渠道独立支付二维码

## 变更摘要

普通及优惠加油包均使用渠道独立二维码。移除扫码后识别 App、网页跳转支付的中转流程。
一个业务订单对应微信 Native 与支付宝 precreate 二维码，保持同一优惠、同一金额和同一截止时间。
订阅继续微信 H5 纯签约、首扣、续费；优惠订阅也只展示微信渠道。
本次未实现手机返回订阅页后的优惠账号同步。

## 接口

以下下单、换购及私人状态接口要求当前账号的 Cookie/Session 或 JWT Bearer；二维码本身不携带登录凭证。
服务端继续校验 offerToken 所属账号、商品、截止时间和占用状态。

### 加油包下单

`POST /api/boost-packs/purchase`，`Content-Type: application/json`

```json
{"boostPackId":1,"paymentChannel":"dual","offerToken":"原优惠令牌"}
```

自定义金额使用 `{"amount":100,"paymentChannel":"dual","offerToken":"原优惠令牌"}`，不能同时传 boostPackId。
不使用优惠时省略 offerToken。旧客户端 `unified` 参数转换为 `dual`，不会生成新的 unified 订单。

就绪响应示例（金额及时间仅为示例）：

```json
{"code":0,"message":"success","data":{
  "orderNo":"LB_EXAMPLE","status":"pending","paymentChannel":"dual",
  "wechatQrUrl":"weixin://wxpay/example","alipayQrUrl":"https://qr.alipay.com/example",
  "amount":80.00,"originalAmount":100.00,"discountRate":0.80,
  "serverTimeEpochMs":1800000000000,"orderExpiresAtEpochMs":1800001800000,
  "paymentProcessing":false
}}
```

渠道尚未初始化或正在关单时返回 `paymentProcessing:true`，两个 QR 字段为空，客户端等待状态查询；这不是支付成功。
`qrCodeUrl` 不再是加油包统一回退地址。单渠道老客户端可继续传 `wechat` 或 `alipay`，只返回该渠道二维码。
海外 Airwallex 原有支付入口保留。

### 状态与恢复

`GET /api/payment/orders/{orderNo}/status`（登录且属于该账号），在原字段上增加 `wechatQrUrl` / `alipayQrUrl`。
只有 pending、ready 且未过期才返回 QR。二维码恢复只读取持久化结果，不重新请求支付机构、不延长订单有效期。

`POST /api/payment/orders/{oldOrderNo}/replace` 请求与原接口相同：

```json
{"requestId":"同一次换购持续复用的请求ID","offerToken":"原优惠令牌","target":{"orderType":"boost_pack","amount":100}}
```

换购状态查询 `GET /api/payment/order-replacements/{requestId}` 仍返回 processing/completed/old_order_paid/offer_unavailable。
`completed` 只说明新业务订单已提交，必须继续判断其 `paymentProcessing` 和订单 paid 状态；不能视为付款成功。
生成渠道二维码失败不回滚已提交的新订单号。后台确认关闭后释放该订单占用。

旧优惠加油包没有可恢复的渠道 QR 时，下单返回 `42304`，`data.currentOrderNo` 是待关闭旧订单；客户端复用现有换购接口，即使商品未改变。

### 订阅

`POST /api/subscription/create {"planId":3,"paymentChannel":"wechat","offerToken":"可选优惠令牌"}`。
返回微信 H5 签约页 QR；新订单 channel=wechat。旧 dual/unified 请求转换为微信签约。
签约页、查询和回调 URL 保持：

- `GET /api/payment/unified/wechat/h5-sign/{orderNo}`（公开订单签约入口）
- `GET /api/payment/unified/orders/{orderNo}/status`（公开有限订单信息，不返回加油包 QR）
- `POST /api/payment/unified/wechat/sign-notify`
- `POST /api/payment/unified/wechat/papay-notify`
- `POST /api/payment/unified/alipay/sign-notify`

保留地址中的 unified 是为了已有回调配置兼容，不再包含渠道自动分流逻辑。
`GET /api/payment/unified/route?orderNo=...` 及 `/route/{orderNo}` 一律 HTTP 410，提示返回原购买页重新生成。

## 前端接入

1. 加油包始终展示微信/支付宝切换按钮，包括首充、9 折与换购订单。
2. 选微信只显示 wechatQrUrl，选支付宝只显示 alipayQrUrl；禁止回退到另一渠道或旧统一路由。
3. 切渠道只切同一订单已返回的 QR。缺失对应 QR 时不能继续展示上一个渠道的图。
4. paymentProcessing、已关闭、已过期时隐藏 QR；恢复 ready 后从状态响应生成当前所选渠道 QR。
5. 继续用服务端时间与订单截止时间倒计时，忽略过期异步响应，关闭弹窗后不得回写 QR。
6. Electron 当前仅跳 Portal 定价，无需改支付 SDK；如有直接下单方，同样消费上述双字段。

## 关单与边界

- 每个渠道均需要查单/关单确认。任何一端已付则确认原订单，停止换购；未知保持 processing。
- 支付宝 precreate 扫码前可能是 NOT_FOUND，不能把它当成安全关单证明。若渠道拒绝关闭尚未扫码的预下单二维码，换购需等待原截止时间后核查，不能承诺立即完成。
- 微信使用原订单绝对截止时间；支付宝使用 time_expire 和二维码相对有效期，不重新延长时间。支付宝不足一分钟不再预下单。
- 付款后后台关闭另一渠道。两端都已支付时标记 flow state=review、close reason=duplicate_channel_payment，保留 paid 和一次发放的权益，交由对账处理，不自动退款。
- 初始化失败/进程中断由既有后台恢复任务每 10 秒扫描；活跃初始化有 60 秒保护，未确认不可支付前不释放优惠。

支付宝时间参数来自[官方 SDK 定义](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayTradePrecreateModel.java)；预下单尚未创建交易的行为见[官方当面付说明](https://developer.alibaba.com/docs/doc.htm?articleId=105444&docType=1&treeId=524)。

## 发布顺序

1. 先应用 Server `sql/V95__direct_payment_qr.sql`，只新增两个可空 TEXT 字段，无 UPDATE 数据回填、无外键。
2. 发布 Server，再发布 Portal；移除环境中不再使用的 `unified-pay.route-base-url`。微信签约/付款及支付宝付款通知配置不变。
3. 旧二维码会显示失效；旧签约/支付回调仍可处理。不得手动修改订单状态或清空优惠占用。
4. 真机验收普通/优惠、固定/自定义加油包、两个渠道扫描、切渠道不新建订单、跨商品换购、到期及订阅签约。代码检查不等价于真实付款验收。

本次只提供 DDL 和代码，不执行数据库变更或部署。

## 测试分支合并注意

本次在临时目录合并 `dev-deploy` / `feature-dev` 验证。合并时保留 Server 的 `SubscriptionTrialService` 构造器依赖和体验活动回调，再加入 `PlatformTransactionManager`；对应测试同时保留这两项依赖。
Portal 保留 `paymentSession` / `isCurrentPayment` 会话校验及 `isSubscriptionTrial`，叠加渠道二维码选择与处理状态检查，不能将旧 `paymentRevision` 标识带回测试分支。企业测试金额保留目标分支的商品配置，仅将渠道改为 dual。

## 本次验证记录

- 功能分支 Portal：`npm run lint`、`npm run build -- --mode test` 通过。
- 功能分支 Server：169 项支付相关测试通过；`./gradlew build -x test` 编译打包通过。
- 临时合并 `feature-dev`：Portal lint/test build 通过；临时合并 `dev-deploy`：173 项支付相关测试及编译打包通过。
- 未提交、未修改测试分支指针、未推送或部署。
- 全量 `./gradlew build` 未通过：已有 `EnterpriseServicePurchaseTest.adminCreditBatchTotalIncludesConfiguredBonus` 的 mapper stub 与实现不符；`DepartmentPermissionOvermindConfigTest` / `HelloControllerTest` 启动 Spring 上下文时测试 MySQL 连接超时。重复出现同一连接超时后中止该轮全量运行；没有调整无关业务或掩盖这些失败。
- 未进行浏览器/真机扫码校验。

## 2026-09-17 测试服二维码持续确认修复

测试库漏执行 V95，缺少 `wechat_qr_url`、`alipay_qr_url`。渠道下单后写入二维码失败，被原来的通用初始化异常处理转成 `paymentProcessing=true`；轮询只能继续等待关单，无法取得二维码。

测试库现已补齐这两个可空 TEXT 字段并核对。仅执行新增字段 DDL，没有 UPDATE 订单、优惠或积分数据。初次实现时“未执行数据库变更”的记录为当时状态；其他环境仍需按发布顺序先执行 V95。

服务端补充防护：订单 INSERT 显式包含二维码字段，缺少迁移时会在调用支付渠道之前失败；初始化期间的数据库异常返回 `40506`，提示“支付二维码生成失败，请稍后重试”，不再将数据库错误返回为成功的等待响应。已创建订单仍保留 pending/unknown，由既有流程查单、关单，不释放未经确认的优惠。

接口路径、请求、鉴权和正常响应不变。Portal 继续按现有错误分支展示失败与重新生成入口，无需修改界面；Electron 仍跳转 Portal 购买。已有失败弹窗需要关闭后重新发起；已占用优惠的订单须等待正常关单/换购完成，不能手动清空状态。
