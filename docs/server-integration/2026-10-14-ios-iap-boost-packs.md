# Electron：订阅与 Web 加油包边界接入说明

- 日期：2026-10-14
- 状态：**现有逻辑说明与文档修正，不新增功能，不修改 Electron 或手机 App 源码。** 未连接数据库、核验部署状态或执行测试。
- 依据：[订阅与 Web 加油包边界 Spec](../../../lobsterai-server/docs/specs/payment/feature-2026-10-14-ios-iap-boost-packs.md)、[服务端与各端接入说明](../../../lobsterai-server/docs/integration/2026-10-14-ios-iap-boost-packs.md)、[现有支付 API](../../../lobsterai-server/docs/api/payment-api.md)、[现有 Apple 订阅 API](../../../lobsterai-server/docs/api/apple-iap-api.md)。

## Change Summary — 变更摘要

Web 与 Apple 个人订阅互斥，Apple IAP 仅提供订阅。加油包仍只通过现有 Web 支付购买，所有个人订阅渠道均可购买，包括 Apple 会员和未订阅用户。购买加油包不创建、续期或切换会员。

有效加油包属于服务端确认的同一 `userId`，在 Portal、Electron 和手机端按同一账号消费；它不按 Web/Apple 会员身份拆分。原有效期与退款规则保持，不增加 Apple 独立加油包余额。

现有桌面入口已符合目标：`src/renderer/components/LoginButton.tsx` 的 `handleRecharge` 通过 `shell.openExternal` 打开 Portal，未因 Apple 会员禁用；`handleUpgradePlan` 才引导 Apple 订阅管理。本次无需桌面新增购买功能。

## Endpoint Details — 原有接口

| 方法 / 路径 | 当前用途 |
|---|---|
| `GET /api/user/quota` | 现有个人额度及会员状态；保持 JWT 认证和原响应 |
| `GET /api/user/profile-summary` | 现有账户总额与积分来源，沿用 `totalCreditsRemaining`、`creditItems` 及可选 Apple 管理字段 |
| `GET /api/boost-packs/credits`、`/history` | 原余额与历史协议，Cookie/Session 或 JWT；本说明不要求桌面新增调用 |
| `GET /api/boost-packs`、`POST /api/boost-packs/purchase` | Portal 负责现有 Web 商品和下单；桌面继续打开 Portal |
| `GET /api/iap/apple/entitlements` | 已有个人 JWT 权益查询；Apple 订阅与 Web 加油包可同时存在，不提供 Apple 加油包购买 |

完整请求响应见支付 API 第 4、5 节及 Apple API 第 6、11 节。不存在本次新增的余额、批次、加油包商品或准备接口；不把 Web 购买参数改成 `paymentChannel=apple`。

## Action Items — 桌面行为与兼容要求

1. 保留充值打开 Portal、Apple 套餐升级打开 Apple 管理的职责划分。不要按 `hasAppleSubscription` 隐藏个人充值按钮。
2. `src/renderer/services/endpoints.ts` 的 `getPortalRechargeUrl()` 当前返回 Portal 根页；保持实际路由，不因旧测试中的路径字符串而宣称充值入口已直接定位加油包标签。本次无需为此改代码。
3. 保留 `src/renderer/store/slices/authSlice.ts`、`LoginButton.tsx` 的服务端总额展示。会员资格、套餐积分与加油包余额是不同概念，不能用是否有加油包替代会员判定，也不自行重复累加服务端总额。
4. 保留 `creditItems[].type`、数字与日期格式、原有效期展示和字段缺省兼容。无需增加永久批次类型、来源字段、日期回退或新版媒体账单。
5. 沿用已有 profile-summary 刷新、账户代际校验与过期响应丢弃逻辑，避免切换账号后显示上一账号余额。本次无新的缓存或 IPC 接口要求。

## Auth Requirements — 认证与来源边界

桌面原用户 API 使用现有 JWT，服务端以已认证 `userId` 解析个人余额；不同账号、个人与企业上下文不因充值自动合并。

“加油包仅走 Web”表示产品入口和现有支付流程，不等于服务端验证了浏览器来源。原购买接口接受 JWT，有效 token 的调用者技术上可直接请求；普通 `source` 或 User-Agent 不构成可信认证。不要为限制购买入口禁用 JWT、改变原认证协议或要求旧客户端同步升级。

桌面通过系统浏览器打开 Portal 的现有路径保持；该事实不构成手机 App 新增 WebView 充值、扫码或外链导购入口的要求。手机 App 本次不改源码，其接入范围以服务端说明为准。

## Notes & Caveats — 范围与核对

本修正不新增 Consumable、Apple 加油包 SKU、永久积分、表结构、接口、开关、迁移或媒体账单协议。原 Apple 订阅单渠道互斥及旧 Web 加油包购买、消费、退款继续有效；本地代码核查不证明相应 Apple 能力已上线。

后续回归可核对：Apple 会员能打开 Portal 充值；升级仍引导 Apple；同账号在各端消费同一有效加油包；会员到期不提前清除加油包；切换账号不串余额。此次仅文档变更，未运行测试或构建。
