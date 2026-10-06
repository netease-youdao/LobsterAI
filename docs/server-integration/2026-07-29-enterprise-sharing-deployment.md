# 企业账号分享与部署接入说明

日期：2026-07-29

## Change Summary

`lobsterai-server` 现已允许有效企业的普通成员和超级管理员使用现有 artifact 分享、静态部署和动态 Node 服务部署，不要求该用户同时拥有个人订阅。分享与部署属于企业产品权益，不消耗企业积分、成员月度额度或个人积分。

本次契约和数据归属变化：

- `GET /api/user/quota` 新增权威字段 `shareEntitled`、`deploymentEntitled`。
- `GET /api/enterprise/context` 同步返回这两个字段。
- `subscriptionStatus` 在企业账号下仍为 `enterprise`，不伪装为个人订阅的 `active`。
- 分享和部署 API 的请求结构保持不变；服务端只从签名 JWT 解析 `accountMode` 和 `enterpriseId`。
- 分享与部署资源按 `userId + accountMode + enterpriseId` 隔离。同一用户的个人账号、企业 A、企业 B 是三个独立资源和数量统计空间。
- 企业分享与部署沿用个人订阅当前的全局数量、包大小、审核、供应商和运行配置，不新增企业专属限制。

## Endpoint Details

所有接口继续使用统一响应结构：

```json
{
  "code": 0,
  "message": "success",
  "data": {}
}
```

### 发布权益

`GET /api/user/quota`

企业账号响应示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "planName": "企业版",
    "subscriptionStatus": "enterprise",
    "shareEntitled": true,
    "deploymentEntitled": true,
    "accountMode": "enterprise",
    "enterpriseId": 1001,
    "creditsLimit": 5000,
    "creditsUsed": 1200,
    "creditsRemaining": 3800
  }
}
```

字段规则：

- `shareEntitled` 是分享产品权益的权威字段。
- `deploymentEntitled` 是静态和动态部署产品权益的权威字段。
- 企业账号缺少显式字段时客户端必须 fail closed，不得回退到个人订阅状态或显示个人购买入口。
- 企业积分余额为零不改变这两个权益字段；分享与部署不走企业积分计费。
- `deploymentEntitled=true` 不替代 `share-deployment.enabled` 等运行时检查。平台停服或供应商异常继续返回现有部署错误，不能解释为订阅失效。

### 企业上下文

`GET /api/enterprise/context`

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "accountMode": "enterprise",
    "enterpriseId": 1001,
    "memberId": 2001,
    "role": "member",
    "shareEntitled": true,
    "deploymentEntitled": true
  }
}
```

服务端仅在企业有效且当前用户仍是 `joined` 的 `member` 或 `super_admin` 时返回有效企业上下文。

### 分享接口

现有接口不增加 `accountMode` 或 `enterpriseId` 参数：

- `POST /api/html-shares`
- `PUT /api/html-shares/{shareId}`
- `PUT /api/html-shares/{shareId}/access-mode`
- `PATCH /api/html-shares/{shareId}/status`
- `DELETE /api/html-shares/{shareId}`
- `GET /api/html-shares/source`
- `GET /api/html-shares/my`
- `GET /api/html-shares/{shareId}`

列表、详情、按 `clientSourceKey` 查询、更新、关闭和恢复都只作用于当前 token 的账号空间。

### 部署接口

现有接口不增加账号参数：

- `POST /api/share-deployments/node`
- `POST /api/share-deployments/static`
- `GET /api/share-deployments/{deploymentId}`
- `GET /api/html-shares/{shareId}/deployment`

服务端创建部署时固化当前所有者。异步 Worker 执行替换和 active 数量清理时使用部署记录中的所有者，因此企业 A 的任务不会停止个人账号或企业 B 的部署。

## Frontend Action Items

1. 分享入口和操作统一读取 `quota.shareEntitled`；部署入口和操作统一读取 `quota.deploymentEntitled`。
2. 个人账号可为兼容旧服务端保留 `subscriptionStatus === "active"` 回退；企业账号缺少显式字段时必须禁用并提示企业身份不可用。
3. 企业无权益或上下文失效时提示重新登录或联系企业管理员，不展示个人订阅购买按钮。
4. 本地账号空间键统一使用：

   ```text
   personal:{userId}
   enterprise:{userId}:{enterpriseId}
   ```

5. 分享/部署 lookup、`clientSourceKey` 映射、创建/更新/部署中的状态和错误提示都必须绑定 owner key。
6. 登录或切换个人/企业身份时递增 account generation，清理当前发布 UI；旧 generation 的延迟响应和异常不得写入新账号。
7. 主进程在打包和上传前捕获 owner key；发送请求前及收到响应后均复核当前账号。切换账号后不得用新 token 完成旧账号的发布请求。
8. 收到 `41600`、`41601`、`41602` 或 `41612` 时刷新认证/企业上下文并停留在企业处理路径；个人账号的 `41307` 继续使用个人订阅提示。

## Auth Requirements

- Electron 业务接口继续使用 JWT Bearer 认证。
- `accountMode=enterprise` 和 `enterpriseId` 必须来自服务端签名的 access token；刷新 token 后保持同一账号上下文。
- 客户端不得在 multipart、JSON、query string 或普通 header 中新增可覆盖归属的企业 ID。
- 同一 `userId` 不代表同一发布所有者，所有缓存和异步请求必须同时绑定账号模式与企业 ID。
- 企业普通成员与超级管理员拥有相同的本人分享/部署权益；超级管理员本期不能代管其他成员资源。

## Migration, Rollout & Rollback

发布顺序：

1. 执行服务端迁移 `sql/V66__publishing_account_scope.sql`，为 `html_shares`、`share_deployments` 增加 `account_mode`、`tob_enterprise_id` 和所有者索引。历史记录自动归入个人空间。
2. 部署服务端权益和所有者隔离逻辑。
3. 发布使用显式权益、owner key 和 account generation 的 LobsterAI 客户端。
4. 使用同一测试用户分别在个人、企业 A、企业 B 验证分享、静态部署、动态部署、相同 `clientSourceKey` 和超限清理。

回滚客户端不会破坏服务端数据，但旧客户端无法正确开放企业入口。回滚服务端时必须先关闭企业分享和部署入口；数据库新增列和索引保留，不做破坏性回滚。

## Notes & Caveats

- 当前没有企业专属数量限制，但现有 live 分享和 active Node 部署限制按每个 owner 空间分别统计。
- 企业成员被移除或企业停用后，新的创建、更新、恢复和重新部署会被拒绝；本期不会自动关闭已有公开资源。
- 公开分享 URL、分享码、内容审核、访问统计和内部 Admin 运维接口保持不变。
- 数据库迁移必须先于新服务端写入企业资源；滚动发布期间不能让旧实例处理企业分享/部署写请求。
