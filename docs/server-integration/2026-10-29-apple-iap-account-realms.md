# 服务端接入：Apple IAP 账号环境隔离（2026-10-29）

## 变更摘要

服务端按已认证业务账号选择 Apple 账本：测试服全部个人账号 Sandbox；正式服已登记专用测试/审核账号 Sandbox，其他账号 Production。管理员通过精确登录手机号查找已落库账号，分配固定到内部 userId；客户端不传测试名单或环境参数。此版本包含服务端和 Admin 实现，本项目只更新接入文档，不要求同步发布客户端。

手机 App 源码不在本次范围；其详细接入在 [服务端 iOS 接入文档](../../../lobsterai-server/docs/integration/2026-10-29-ios-iap-account-realms.md)。

## 原接口与认证

现有 `GET /api/subscription`、用户信息/额度、模型权限、`POST /api/proxy/chat/completions` 及媒体接口保持原请求/响应结构和认证行为。Portal 继续使用既有 Cookie/Session；Electron 继续 JWT Bearer。IAP 本身仍仅接受原个人 JWT，企业 JWT/普通 Cookie 不能替代。

```http
GET /api/subscription
Authorization: Bearer <原个人 accessToken>
```

Portal 使用它原有登录 Cookie 发相同业务请求，无需改为 JWT-only。响应仍是 `{ "code": 0, "message": "success", "data": { ...原字段 } }`，不要新增客户端的 environment/testAccount 请求字段。会员、Apple 可用积分和真实已付款风控由服务端分别判断；不要用“有 Sandbox 会员”替代真实现金付费证明。

## 前端事项

- 保持按服务端会员/额度结果展示。正式专用账号可以体验购买额度内的真实产品功能；实际算力成本属于测试成本。
- 正式专用账号不能新建 Web/Android 真实现金订阅、加油包、现金奖励或企业资金操作。遵循原购买资格/失败响应，不能通过改服务地址、重试另一支付渠道或自行增加免费余额绕过。
- 账号暂停/到期后新执行被拒绝，功能会员无效；历史交易/余额事实仍可查询。已经开始的 SSE/媒体结算和退款继续沿原执行账本，不由前端切换环境补偿。
- 验收旧客户端：普通正式账号原有支付与模型调用、测试服普通账号 Sandbox、正式专用账号会员展示及一次实际消费、暂停后的新请求、暂停前已开始的执行收尾。任何可选环境提示都不能作为授权来源。

## 上线及兼容

按 [双端发布手册](../../../lobsterai-server/docs/operations/2026-10-29-billing-realms-rollout.md) 先增量迁移 V128，再部署理解协议的正式与测试服务，完成维护窗口内的历史导入及双端 ACK 后激活。两个服务都需升级，可以分批发布；不是只改一处 environment。Admin 需发布新页面。

旧用户接口不增加必填字段或新的管理错误码。协议 1 保持部署默认行为；协议 2 激活以后不能回退到不理解此隔离的新旧历史二进制。客户端无需同步升级，但本次编译/静态检查没有替代真实旧端联调。本次未执行数据库迁移、部署或 App Store Connect 配置修改。
