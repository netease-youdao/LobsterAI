# 个人资金故障隔离与独立订阅管理接入（2026-10-15）

本文件描述服务端本轮新增契约及 Electron 后续接入要求。本次只新增文档，未修改 Electron 请求或页面源码，未部署、执行 DDL 或激活资金协议。服务端协议说明见[个人资金隔离 API](../../../lobsterai-server/docs/api/personal-spend-isolation.md)；已有 Apple 契约仍见[Apple IAP 接入](2026-10-09-ios-iap.md)。

## 1. 变更摘要

- 新增 `GET /api/subscription/management`，分别返回已确认的 Web 管理入口和 Apple 管理状态。Apple 权益不可读时，仍可展示已经确认的 Web 取消入口。
- 原 `GET /api/subscription` 的完整 DTO、认证、字段类型和成功语义不变；不把原完整响应悄悄替换成部分响应。新增管理查询只提供管理事实，不提供余额、购买资格或消费授权。
- 个人资金 protocol 1 激活后，Apple 权益为 UNKNOWN 时可按服务端验证结果使用已确认的非 Apple 资金来源；未知来源不按零余额处理。服务端负责执行身份、来源快照、单个占用、结算与代次校验。
- 代理请求和 SSE 错误沿用旧形状，不要求客户端新增 executionId、usageId、资金策略或数据库版本参数。

## 2. 独立订阅管理接口

```http
GET /api/subscription/management
Authorization: Bearer {accessToken}
Accept: application/json
```

无 query 参数、无请求体。Electron 使用现有 access JWT、续期和账号上下文流程；认证与原 `/api/subscription` 一致，不引入远控设备凭据或新的客户端授权。服务端继续校验当前账号状态；未登录、失效登录和禁止访问不能转换成空订阅。

Apple 状态暂不可用、Web 取消事实已确认时：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "webManagement": { "status": "known", "canCancel": true },
    "appleManagement": { "status": "unavailable" }
  }
}
```

Apple 存在订阅或续费管理关系时：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "webManagement": { "status": "known", "canCancel": false },
    "appleManagement": {
      "status": "known",
      "hasSubscription": true,
      "managementUrl": "https://apps.apple.com/account/subscriptions"
    }
  }
}
```

已确认 Apple 不存在该管理关系时：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "webManagement": { "status": "known", "canCancel": false },
    "appleManagement": { "status": "known", "hasSubscription": false, "managementUrl": null }
  }
}
```

| 字段 | 消费规则 |
|---|---|
| `webManagement.status=known` | 本次 Web 管理查询成功；`canCancel` 表示是否存在可取消的既有协议。 |
| `appleManagement.status=known` | 才可使用本次 `hasSubscription` 和 `managementUrl`。 |
| `appleManagement.status=unavailable` | `hasSubscription`、`managementUrl` 不存在，不得补成 false/null 并声称已经查明。 |
| `canCancel=true` | 继续调用原 Web 取消接口；真正取消结果以服务端响应为准，不能只隐藏按钮就标记取消成功。 |

账户或 Web 管理查询本身失败时，接口可以整体失败，不保证任何故障都返回部分成功。Apple 管理关系也不是完整会员状态；例如自动续费、当前权益和当期余额仍须各自权威接口确认。

## 3. Electron 具体待办与兼容回退

1. 订阅管理区域可独立调用新接口，不再必须等待完整余额查询成功才获取 Web 取消入口。保留完整 DTO 原有解析与展示，不将新接口结果合并成伪造的完整订阅对象。
2. 仅新接口明确 HTTP 404、表明旧服务不支持时，回到原有订阅管理流程。若原接口也失败，保持未知/暂不可用；不根据 404、网络失败、零余额或缺字段推断“没有 Apple 订阅”或“允许购买”。不要把 401/403、5xx 或业务错误当作版本不支持。
3. `unavailable` 展示暂不可用或重试入口，保留已经确认的独立 Web 事实。账号切换后丢弃旧账号响应；不能跨账号沿用缓存管理状态。普通订阅字段中的数值 0 只按其原字段语义解释，不能当成无订阅证明。
4. 沿用现有 JWT 刷新和用户显式重试。不得为新接口或代理流新增无提示的生成重试、重新发起新的执行身份，或用自动重试掩盖未知结算。

## 4. 代理消费与重试边界

原请求继续发送，例如：

```http
POST /api/proxy/chat/completions
Authorization: Bearer {accessToken}
Content-Type: application/json
```

```json
{"model":"<configured-model-id>","messages":[{"role":"user","content":"你好"}],"stream":true}
```

无需客户端生成或传入 executionId。HTTP 失败和 SSE 中的错误继续按原字段与错误流程处理；本轮不新增客户端必须识别的资金响应格式，也不保证 Apple 故障期间所有请求都可以成功。

protocol 1 启用后，服务端仅在来源、余额、模型及计价边界均已确认时允许降级消费：

- 使用已确认的非 Apple 来源；免费/月度余额重置或套餐换周期后，旧执行不能自动扣到、退入新的来源代次。
- 同一用户的确认来源策略受单个占用保护，不用并发请求绕过保留额度。模型必须支持服务端可验证的成本边界；无法界定时按原失败流程返回。
- 用量未知、网络中断、未收到可靠完成信号等情况保留占用和待核对证据，不假定零消费、不自动释放或向新周期追扣。
- 已有正常路由的显式 fallback 仍按既有配置和服务端可安全重试条件处理；它不等于客户端可以隐式重发生成。protocol 1 下服务端关闭内部 network/finish 失败导致的透明重执行；结果未知时不能把请求当作确定未执行。

上述行为由服务端控制。客户端不配置协议版本、数据库状态、reader/writer 证明或来源代次，也不能自行切换成所谓降级支付模式。

## 5. 产品边界与发布顺序

产品规则保持不变：Apple 与 Web 订阅互斥；Apple 入口不提供加油包购买；Web 加油包仍可供 Apple 或 Web 订阅用户按原资格购买。独立管理状态不修改上述规则，购买入口仍使用原服务端资格校验。

建议顺序：

1. 服务端先部署向后兼容的新管理接口及资金实现，保持资金协议为 0；旧 Electron 继续使用原接口和原 DTO。
2. 服务端完成 MySQL 5.7 增量结构、所有余额/重置 writer 与 reader 升级，以及并发、UNKNOWN、退款、代次、旧客户端和故障验收后，才显式激活 protocol 1。部署源码不等于已经激活；消费方无需配置这些门禁。
3. Electron 后续接入新管理接口，并验证旧服务 404、Apple unavailable、整体查询失败、账号切换和取消结果未知的展示。此次文档交付不代表该 UI 已实现。
4. 回滚或暂停时由服务端保留既有执行占用、原代次与待结算证据；客户端不得通过清缓存、重造请求或重试循环“恢复”余额。若仍有新协议执行在途，服务端须遵循对应 reader/writer 兼容回滚方案。

本次为文档变更，没有新增测试运行；不能以此前编译或单元测试代替实际服务端协议激活验收。
