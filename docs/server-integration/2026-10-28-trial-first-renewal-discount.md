# 0.01 试用活动：账户菜单入口与首次续费优惠

## 变更说明

lobsterai-server 分支 `feat/penny-first-renewal-discount` 在现有 `GET /api/subscription-trial` 响应中新增三个可选字段，供客户端控制「我的」菜单中的 0.01 活动入口，并展示首次续费优惠信息。接口路径、已有字段与认证行为不变。

Portal 新增公开活动页 `<portalBase>/activity/penny`，未登录也可访问。

## 接口

`GET /api/subscription-trial`（客户端经 `window.electron.subscriptionTrial.status()` 调用，主进程有 Token 时带认证，否则走公开请求）

新增字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| clientMenuEntryVisible | boolean，可选 | 活动进行中且 Overmind 开关 `clientMenuEntryEnabled` 打开时为 `true`；运营可通过开关隐藏入口，无需发版 |
| firstRenewalPrice | number，可选 | 首次续费价格，例如 `24.5` |
| firstRenewalDiscountEnabled | boolean，可选 | 首次续费优惠是否开启 |

示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "campaignCode": "<campaign-code>",
    "active": true,
    "visible": true,
    "eligible": true,
    "serverTimeEpochMs": 1793145600000,
    "endAtEpochMs": 1795737600000,
    "clientMenuEntryVisible": true,
    "firstRenewalPrice": 24.5,
    "firstRenewalDiscountEnabled": true
  }
}
```

## 客户端改动

- `SubscriptionTrialState`（`src/shared/subscriptionTrial/constants.ts`）新增上述三个可选字段。
- `getPortalPennyActivityUrl()`（`src/renderer/services/endpoints.ts`）返回 `<portalBase>/activity/penny?keyfrom=client_menu`。
- `LoginButton` 的账户菜单新增「0.01解锁 1000积分」入口，点击后在外部浏览器打开活动页：
  - 显示条件：`clientMenuEntryVisible === true` 且（未登录 或 `eligible === true`）；企业账户始终不显示。
  - 已登录：入口位于「邀请好友赚 4000 积分」上方，菜单打开前拉取一次状态。
  - 未登录：入口可见时，点击登录按钮先弹出小菜单（「登录」+ 活动入口）；不可见时保持原有直接登录行为。未登录状态在进入未登录态时预取，避免登录点击等待网络。

## 认证要求

接口本身支持匿名和 JWT 两种访问；`eligible` 仅对已登录用户有意义。活动页为 Portal 公开页面。

## 注意事项

- 兼容旧服务端：字段缺失或请求失败时入口隐藏，客户端行为与改动前一致。
- 发布顺序无要求；需服务端与 Portal 活动页上线后打开 `clientMenuEntryEnabled` 才会显示入口。
