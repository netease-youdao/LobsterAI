# Apple 订阅接入后的桌面登录兼容修复

日期：2026-10-13。状态：服务端 SQL 已修复，待部署后完整登录验收。

## 1. Change Summary

网页已登录且桌面收到回调后，`POST /api/auth/exchange` 会构建用户配额。新增 Apple 有效周期查询在 MySQL 5.7 的相关子查询 `JOIN ON` 中引用外层别名，触发 `1054 Unknown column 'p.subscription_source_id' in 'on clause'`，即使该账号没有 Apple 订阅也会失败。

服务端把相关条件移到子查询 `WHERE`，保留用户、应用范围、交易链、退款、升级及宽限期的全部校验。共用片段的主/赠送积分扣费 SQL 同步修复。接口路径、请求、响应字段、错误码和认证协议均不变。

## 2. Endpoint Details

- `POST /api/auth/exchange`
- 请求头：`Content-Type: application/json`；使用一次性授权码，无需预先携带 JWT。
- 请求示例：`{"authCode":"<本次网页授权生成的授权码>"}`。既有可选客户端元数据仍按原格式发送。
- 成功响应示意，省略其他既有用户和配额字段：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "accessToken": "<access-token>",
    "refreshToken": "<refresh-token>",
    "user": { "userId": "123" },
    "quota": { "subscriptionStatus": "free" }
  }
}
```

旧额度读取接口也受益于同一 SQL 修复，无需新增接口或修改客户端解析。

## 3. Frontend Action Items

本修复不要求修改 Portal 或 Electron 源码。服务端重新部署后，从桌面重新发起登录，完成网页授权并验证桌面进入登录态、正常刷新 quota。不要重放先前失败的回调：授权码在换码开始时已被原子消费，失败后需重新获取。网页显示登录成功不等于桌面已经成功换取 Token。

## 4. Auth Requirements

保留原有 Web Cookie/Session → 一次性 authCode → Electron JWT 流程。授权码有效期仍为 5 分钟、仅能消费一次；`APPLE_IAP_ALLOWED_ORIGINS` 只作用于 `/api/iap/apple/**`，不限制 `/api/auth/exchange`。

已确认当前服务端分支部署在 `https://lobsterai-server-dev.inner.youdao.com`，现有登录入口为 `https://lobsterai.inner.youdao.com/`，其 API 对应 `dev-deploy` 分支；均使用 test profile。仓库中两分支的默认 Redis、JWT、数据库和授权码协议一致，没有登录 API 域名白名单。不同域名本身不是此次 SQL 失败的原因；若实际部署覆盖了 Redis/命名空间或用户库配置，应另外核对运行时一致性。

## 5. Notes & Caveats

- 仅需重新部署服务端修复包，无需数据库迁移、商品初始化或客户端升级。
- 指定 MySQL 5.7 测试库中已只读复现旧 SELECT 错误，修复后 SELECT 与主/赠送积分扣费的 EXPLAIN 均通过；未执行扣费或修改数据库数据。
- 已补充静态 SQL 回归测试源码；按项目约定不运行服务端测试。数据库只读诊断不替代部署后的完整登录和 Apple Sandbox 支付验收。
- 服务端详细记录：[部署说明](../../../lobsterai-server/docs/integration/2026-10-09-ios-iap-deployment.md)。
