# 内置 Portal JWT 身份与账号切换

## Change Summary

Server 拒绝显式提供的无效 Bearer，不再回退到 Cookie/session。无 Bearer 的普通浏览器登录以及老客户端授权码交换、Token 刷新协议保持兼容。

## Endpoint Details

请求路径、请求体和成功响应没有变化：

```http
GET /api/auth/status
Authorization: Bearer <accessToken>
```

```json
{"code":0,"message":"success","data":{"username":"Example","yid":"example-yid","loginType":"yid"}}
```

```http
GET /api/user/profile
Authorization: Bearer <accessToken>
```

```json
{"code":0,"message":"success","data":{"id":1001,"yid":"example-yid","nickname":"Example","avatarUrl":null,"status":1}}
```

无效、过期、拉黑或非 access 类型的 Bearer 返回 HTTP 401：

```json
{"code":40100,"message":"登录已过期，请重新登录","data":null}
```

历史刷新接口保持不变，不需要在请求头提供旧 accessToken：

```http
POST /api/auth/refresh
Content-Type: application/json

{"refreshToken":"<refreshToken>"}
```

```json
{"code":0,"message":"success","data":{"accessToken":"<new-access-token>","refreshToken":"<new-refresh-token>"}}
```

## Frontend Action Items

- 内置购买页业务 API 由主进程代理，使用当前客户端 accessToken；不透传网页 Cookie、Authorization 或服务端 Set-Cookie。
- Portal 用户资料改为 `/api/user/profile`；移除内置购买页对 `/api/urs/accountinfo` 的授权代理能力。
- 退出、换号、企业身份失效及登录提交回滚时，同步销毁旧 WebContentsView、取消请求并清理分区。下次打开使用新分区和新身份；登录引导保留完成后重试购买页的行为。
- 打开页面前、读取请求体后、请求返回及读取响应体后，检查账号及登录会话编号。旧请求不能在读取请求体期间切换到新 JWT，旧响应不能覆盖新页面。
- 同一身份的 Token 刷新由 AuthSessionManager 完成，不销毁页面。

## Auth Requirements

账号绑定包括用户、个人/企业身份、企业 ID 和登录会话编号。JWT 只保存在主进程，不向 Portal JavaScript 暴露。不带 Bearer 的请求仍可通过浏览器 Cookie 认证；客户端身份 API 不使用 Cookie 回退。

## Notes & Caveats

- 不修改旧客户端浏览器登录、loopback/deep-link 回调、无 PKCE 授权码交换和历史 Token 声明格式。
- 依赖“无效 Bearer + 有效 Cookie”兜底的请求现在会收到 401，这是防止串号的必要变化。
- 建议先发布 Portal 与 Server，再更新客户端；旧客户端可以继续登录及刷新，但不会自动获得本次主进程页面生命周期修复。
- Server 已接收的下单请求不能通过关闭页面撤销。支付回调继续按原订单归属入账，不随客户端切换账号而变更。

- 后续 JWT 退出撤销及历史 Token 兼容边界见 [登录与支付安全补齐](./2026-10-22-auth-payment-security-hardening.md)；精确的 POST `/api/auth/logout` 支持签名有效的过期凭据撤销会话。
