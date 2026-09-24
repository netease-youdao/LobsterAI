# 2026-09-24 客户端内登录与支付

## 变更摘要

- server 支持按 RFC 7636 PKCE（仅 S256）把 Electron 一次性授权码绑定到发起登录的客户端进程，`POST /api/auth/exchange` 新增 `codeVerifier` 字段。
- Portal 登录页新增面向桌面客户端的嵌入模式：客户端在自己的窗口中打开登录页，通过拦截固定的完成地址拿到授权码，不再需要本机 HTTP 回调或系统深链。
- 支付沿用现有 server 接口，没有为客户端新增支付接口。

不传 PKCE 参数的客户端行为不变。

## 接口

### 嵌入模式登录页

打开 Portal 登录页时附加以下参数（hash 路由，例如 `https://lobsterai.youdao.com/portal#/login?...`）：

| 参数 | 取值 |
|------|------|
| `source` | `electron` |
| `transport` | `embedded` |
| `state` | 32 字节随机数，base64url 编码 |
| `code_challenge` | `BASE64URL(SHA256(code_verifier))`，43 个字符 |
| `code_challenge_method` | `S256` |

登录和身份选择完成后，Portal 把窗口导航到：

```
<portal origin>/portal/desktop-login/complete#code=<authCode>&state=<state>
```

该地址只作为客户端拦截的信号，不对应任何页面。code 和 state 位于 fragment 中，即使导航没有被拦截，也不会发送到服务器。

### 换票

`POST /api/auth/exchange`

```json
{"authCode":"<authCode>","codeVerifier":"<43-128 位 RFC 7636 verifier>",
 "uuid":"...","version":"...","firstKeyfrom":"...","latestKeyfrom":"..."}
```

响应不变。授权码签发时带了挑战值，而 verifier 缺失或不匹配时，返回 `code=40102`。授权码在第一次提交时即被消费，失败后不能重试。

### 支付

除公开的商品目录外，支付接口都使用 `Authorization: Bearer <accessToken>`：

| 用途 | 接口 |
|------|------|
| 商品目录 | `GET /api/plans`、`GET /api/boost-packs`（公开）；`GET /api/subscription` |
| 报价 | `POST /api/payment/quote` |
| 下单 | `POST /api/subscription/create`（渠道 `wechat`）、`POST /api/boost-packs/purchase`（渠道 `dual`） |
| 优惠订单换购 | `POST /api/payment/orders/{orderNo}/replace`、`GET /api/payment/order-replacements/{requestId}` |
| 按需生成支付宝码 | `POST /api/payment/orders/{orderNo}/alipay-qr` |
| 订单状态 | `GET /api/payment/orders/{orderNo}/status` |

价格、折扣和积分一律以服务端响应为准。

## 客户端改造

1. 每次登录在主进程生成 `state`、`code_verifier` 和 `code_challenge`，verifier 只保存在内存中。
2. 在隔离的窗口中打开嵌入模式登录页（独立内存会话、不加载 preload、拒绝所有权限、导航白名单），拦截完成地址并校验 `state`，然后由主进程携带 `codeVerifier` 调用 `/api/auth/exchange`。
3. 授权码和 Token 不传给渲染进程。
4. 基于上述支付接口实现套餐选择和二维码界面，请求由主进程发出。

## 认证要求

- `/api/auth/exchange`：无需登录，授权码和 verifier 即凭证。
- 支付接口：需要 JWT access token；`GET /api/plans` 和 `GET /api/boost-packs` 除外。

## 注意事项

- 发布顺序：先 server，再 Portal，最后客户端。使用嵌入式登录的客户端不能早于支持嵌入模式的 Portal 发布。
- 不传 `codeVerifier` 的现有客户端不受影响。
