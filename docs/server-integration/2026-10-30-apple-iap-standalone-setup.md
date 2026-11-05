# 正式服独立 Sandbox：Electron 兼容指南

日期：2026-10-30。本文对应服务端测试/正式服共用 Sandbox 自动准备和审核账号功能的变更；Electron 本次只有文档变更，无需配套发版或强制升级旧客户端。功能尚未完成生产部署和真实 Apple 全流程验收。

## 服务端行为与兼容边界

服务端在正式部署内独立承载 Apple Sandbox。完成目标 SQL 并使用 `prod` profile 发布兼容服务后，默认自动准备本地隔离所需状态；既有 Apple 凭据、真实商品及通知配置仍是外部前提。管理员在 Admin 的 **Apple 测试账号** 页面按 App 登录手机号登记符合条件的专用测试 / 审核账号。

- 正式服已登记账号使用 Sandbox，其新个人消费走服务端 review 计费路径，持久记录计费环境和执行上下文；客户端不生成或指定这些身份。
- 正式服普通账号继续使用 Production，测试服普通账号固定使用 Sandbox。本次不会把共享 `personal_spend_protocol` 从 0 升到 1；当前全局协议为 0 时，普通账号仍沿用原消费路径。已独立激活全局协议的环境保持其原状态。
- 测试与正式服在独立数据库使用相同的手机号登记、列表、暂停/恢复、有效期和 review 消费隔离逻辑。测试服普通账号可直接 Sandbox 购买；在测试后台登记的专用账号可验证完整审核生命周期，不隐藏管理入口。两类账号均沿原资格/健康规则，不给无限权限或跳过验签。
- 暂停或到期的已登记账号保持 Sandbox 归属，停止新购买和新执行，不自动转成普通 Production 账号，不迁移或删除历史订单。
- 旧接口路径、已有请求和响应字段类型、Cookie / JWT 认证行为、既有错误码及 SSE 错误形状保持兼容。没有新增客户端必传字段，不需要传 `realm`、`environment`、`protocolVersion`、`executionId` 或测试账号标记来启用隔离。
- 已激活协议 2 或上一版协议 3 的协调存储保留原路径，不由首次精简准备自动覆盖。服务端的新内部协议不要求旧客户端同步升级。

## 三表精简安装（2026-10-30 修订）

测试/正式服分别在各自数据库首次空/协议 1 安装时自动进入服务端内部协议 4，沿用已有 `billing_realm_control`、`billing_realm_assignments`、`billing_realm_assignment_changes` 三张表，并保留购买上下文/个人执行的可空列及手机号普通索引。账号、原交易链、通知与重试复用既有 Apple IAP 表和作业；不要求本客户端配置 coordinator activation、证据加密密钥、跨服证书或执行双端激活。

已运行协议 2/3 的环境保持原兼容路径及数据，不自动改成 4；已建旧十表不删除，也不重复执行新包的同名结构语句。只改变服务端内部选择和存储依赖，旧客户端无需传协议号、调用新的支付 API 或同步升级。服务端和 Admin 完成发布后，两服都可在各自后台登记已有业务手机号。本次测试服开放不增加 SQL 或客户端参数。旧测试版本不识别 test 协议 4，部署必须先撤流旧测试实例和写者，再启动新版默认初始化；初始化后不回退旧版本、不关闭 standalone、不手改协议。

## App Store 审核方案（2026-10-30 补充）

本轮选择最简的真实购买流程：**已注册的专用业务手机号 → 后台登记 Sandbox 身份 → 在正式服完成 Sandbox 首购 → 同订阅组升级 → 按实际所购档位体验普通个人功能**。登记不会直接赠送最高会员、生成虚构订阅、免扣费或无限积分；尚未购买时仍按原免费权限和有效免费额度运行。首购及升级经 Apple 验签、当前状态核实和履约后，复用普通会员权限、余额、模型访问和发布能力，无需另做审核版客户端。

“完整功能”指个人 App 中对应有效套餐的功能，并不包含管理员权限、企业资金或其他账号资源。测试账号继续隔离 Production 账本，不通过 Web 现金支付、邀请奖励或兑换等入口补足 Sandbox 资金。若审核需要高档功能，应从较低档完成真实 Sandbox 购买，再升级到所需档位，保留首购和升级的可验收状态。

自动初始化成功、手机号登记成功或 `managementReady=true`，都不证明升级所需商品完整可售。提审前应确认至少两档（建议现有四档）商品属于同一订阅组、在服务端 Sandbox 目录启售，并且 Apple 平台商品及等级配置允许实际购买/升级；商品价格和可购买状态以 StoreKit 及真实平台状态为准。`entitlement_rank` / `entitlementLevel` 是保留的兼容元数据，不负责授权，也不能替代 Apple 的订阅等级或判断升级是否已生效。

用户已提供以下两条正式域名通知配置，用于提审及整个审核期间：

- Production：`https://lobsterai-server.youdao.com/api/iap/apple/notifications/production`
- Sandbox：`https://lobsterai-server.youdao.com/api/iap/apple/notifications/sandbox`

开发时在 App Store Connect 仅将 Sandbox Server URL 改为公网 HTTPS 可达的测试服 `/api/iap/apple/notifications/sandbox`，App 同时连接测试 API；提审前切回正式服并在审核全程保持。Production Server URL 始终正式服。切换后确认目标后台收到通知，再做购买/升级/续费/退款验收。切换 URL 不迁移订阅、token、会员或余额；两库账本独立，未知原交易归属只留证据不发权益，历史/状态对账只提供异步补偿。测试与提审自验使用不同的专用 Sandbox Apple 账号，切服务后重新登录并取得该库购买上下文，不复用另一服务缓存 token。

上述地址是用户提供的现状，不是本轮已发送真实 Apple 通知的验收证据。真实凭据、验签、Worker 健康、StoreKit 商品以及审核者能够独立完成的登录流程仍需有效；后台登记业务手机号不等于创建 Apple 测试账户或绕过短信/二次验证。

旧接口路径、认证方式、已有参数及响应语义保持兼容，不新增必传审核标记，不允许客户端通过自报 `environment` 切换账本。本轮不修改手机 App 源码；App 的购买、交易同步、恢复购买和订阅变更要求统一交接到服务端 [Apple IAP API 文档](../../../lobsterai-server/docs/api/apple-iap-api.md)和 [账号隔离接入文档](../../../lobsterai-server/docs/integration/2026-10-29-ios-iap-account-realms.md)。方案及验收边界以 [审核账号 spec](../../../lobsterai-server/docs/specs/payment/feature-2026-10-29-ios-iap-account-realms.md)为准。

本项目只更新接入文档，未修改客户端源码或运行客户端构建/测试；服务端已通过编译与 MyBatis 静态检查，未运行服务端测试，未部署或执行真实支付验收。

## 接口详情与示例

| 接口 | 认证 / 请求 | 本次兼容行为 |
|---|---|---|
| `POST /api/auth/exchange` | 原 Portal authCode 换票请求 | access / refresh Token 字段及语义保持 |
| `POST /api/auth/refresh` | 原刷新请求 | JWT 刷新与认证行为保持 |
| `POST /api/proxy/chat/completions` | `Authorization: Bearer <accessToken>`，原模型请求 JSON | 请求参数、SSE 流式响应与错误形状保持；服务端选择计费环境 |
| `GET /api/subscription`、`GET /api/subscription/management` | 当前个人 JWT Bearer | 原订阅与管理响应保持 |
| 原个人媒体生成及用量接口 | 当前个人 JWT Bearer，原请求 JSON | 已登记账号的新执行由服务端记录 review 计费快照，无新增客户端字段 |

已有订阅管理请求和响应示例（业务值仅作结构示意）：

```http
GET /api/subscription/management
Authorization: Bearer <accessToken>
```

```json
{"code":0,"message":"success","data":{"webManagement":{"status":"known","canCancel":false},"appleManagement":{"status":"known","hasSubscription":true,"managementUrl":"https://apps.apple.com/account/subscriptions"}}}
```

LLM 代理继续发送原 `model`、`messages`、`stream` 等字段，不添加计费环境参数；SSE 不改包裹成上述普通 JSON。服务端不以客户端自报环境、会话标识或 Apple 未验签字段决定资金归属。

## Electron 行动项与认证要求

无需修改 Electron 代码、JWT access / refresh 流程、API 地址、IPC 或本地 SQLite。原 Portal 登录深链保持；需要联调时，在正式服使用管理员按手机号登记的专用账号正常登录，其后普通个人请求自动受到对应服务端计费规则约束。

旧客户端无需理解服务端内部协议 4，也无需调用 `/api/admin/iap/apple/v2/activation` 或测试账号管理接口。后台登记继续使用 IAM 管理员权限；个人 JWT 不获得管理权限。不得将普通账号的未知错误作为切换 Sandbox、重试付费操作或修改本地余额的依据。

## 发布与注意事项

先部署服务端已核验 SQL 和兼容代码，确认实际使用 `prod` profile；对应 Admin 前端部署后，管理员在 **Apple 测试账号** 按手机号登记专用账号。正常用户仍保持已有客户端和消费路径，新 review 账户的计费身份完全由服务端选择。

测试服已开放 Sandbox 新购买；客户端已收到的可信购买回执继续按原 sync / 重试契约上送，不删除或伪造已付款状态。Sandbox 与 Production 的实际凭据、商品和 Apple 通知由外部系统配置，自动准备不替代这些前提。

建议发布验收覆盖旧 Electron 登录/刷新、普通账号 SSE 与个人消费、已登记账号新消费、暂停后的新请求拒绝和历史可信回执处理。本次仅新增文档，未修改 Electron 代码，未运行构建或测试，未执行部署、数据库写入或真实支付。完整操作见 [服务端上线说明](../../../lobsterai-server/docs/operations/2026-10-30-apple-iap-standalone-setup.md)及 [Admin 接入文档](../../../lobsterai-admin/docs/server-integration/2026-10-30-apple-iap-standalone-setup.md)。

## 健康检查与购买准入优化（2026-10-30）

服务端将通知历史探测与购买准入分开：通知历史接口的部分可恢复异常、没有近期成功记录，不再单独阻断新购买；明确的 Apple 鉴权/配置故障、真实 Worker 或持久化能力未就绪仍阻断。商品、账号资格、交易验签、归属、可靠收件和幂等要求保持。用户 API 的路径、认证、请求和响应类型、错误码不变，没有新增客户端必传参数或健康检查调用。

原商品接口的 `purchasable` 和购买准备接口仍由服务端给出最终判断；客户端不根据管理后台的通知历史探测状态增加购买禁用条件，也不自行跳过 prepare 或把已受理支付视作权益到账。已付款回执继续按原同步、重试和恢复契约处理。

管理健康接口新增可选 `providerProbeReady` 与 `warning`，仅供 Admin 分开展示购买依赖和通知历史探测；旧服务省略时保持原处理。`providerProbeReady` 不代表 StoreKit 商品可售、Apple 审核或完整支付验收。本客户端无需读取这些管理字段，无需源码修改、同步发布、新配置或数据库操作。诊断入口见 [Admin 接入说明](../../../lobsterai-admin/docs/server-integration/2026-10-30-apple-iap-standalone-setup.md)。

## 测试环境验收矩阵

| 测试对象 | 操作与预期 |
|---|---|
| 测试服普通账号 | Sandbox 首购、升级、消费；保持未登记身份，作为普通路径对照 |
| 测试服专用手机号账号 | 后台登记 → Sandbox 购买 → review 消费隔离 → 暂停后禁新购/新执行 → 恢复 → 修改有效期/到期拒绝；历史处理继续按原来源 |
| 正式服对照 | 普通账号 Production、登记账号 Sandbox；同套资格、管理与消费逻辑，不能用测试服 Sandbox 结果宣称真实收费已验收 |

两类测试账号的 Apple 环境都为 Sandbox，`reviewAccount` 和消费生命周期仍有区别。管理接口保持 IAM + ADMIN，普通 Cookie/JWT 用户无权登记自己。两服代码与业务流程复用，数据库分别独立；真实 Production 支付须上线后另做受控核验。本次未执行该矩阵、未改 App Store Connect 或数据库。
