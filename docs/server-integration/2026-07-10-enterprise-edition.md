# LobsterAI 企业账号集成说明

日期：2026-07-10

## Change Summary

`lobsterai-server` 新增企业账号上下文。Portal 完成个人版/企业版及具体企业选择后，签发的最终 `authCode`、access token 和 refresh token 绑定所选 `accountMode` 与 `enterpriseId`。Electron 不再重复身份选择，只消费服务端签发的最终身份。

本次客户端集成包括：

- 登录交换、登录恢复和额度刷新时同步企业账号上下文。
- 本地持久化当前企业、角色、权限、成员额度和企业积分池。
- 所有服务端认证请求及 LobsterAI 模型代理请求携带当前已绑定账号上下文头。
- 企业超级管理员和普通成员使用不同账号菜单；个人账号保持现有菜单。
- 企业账号菜单展示当前成员的剩余/月度额度；普通成员标记为“企业身份”。
- 同一账号加入多个企业时，菜单列出全部企业；“进入”只打开对应企业网页，不切换当前客户端 token 身份。
- 任务执行收到企业额度错误时，按结构化错误码和角色展示对应操作。

现有 `enterpriseConfig` 仍表示 IT 配置包，与本功能无关；企业账号统一使用 `enterpriseAccount` / `organizationContext` 命名。

## Endpoint Details

### 获取当前企业上下文

- Method: `GET`
- Path: `/api/enterprise/context`
- Headers:
  - `Authorization: Bearer <accessToken>`
  - `Accept: application/json`
  - `X-LobsterAI-Account-Mode: enterprise`（已有持久化上下文时携带）
  - `X-LobsterAI-Enterprise-Id: <enterpriseId>`（已有持久化上下文时携带）

成功响应：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "accountMode": "enterprise",
    "enterpriseId": 1001,
    "memberId": 101,
    "enterpriseName": "网易有道",
    "role": "super_admin",
    "permissions": {
      "manageEnterprise": true,
      "adjustMemberQuota": true,
      "rechargeEnterprise": true
    },
    "memberQuota": {
      "limit": 8000,
      "used": 4480,
      "remaining": 3520
    },
    "enterprisePool": {
      "total": 216000,
      "used": 38420,
      "remaining": 177580
    },
    "quotaStatus": {
      "available": true,
      "reason": null,
      "errorCode": null
    }
  }
}
```

个人账号返回空上下文或账号模式不匹配错误时，客户端清除本地企业上下文。服务端必须始终以 token 中的身份为可信来源，不能信任请求头任意切换企业。

### 登录交换与登录恢复

客户端继续使用现有接口：

- `POST /api/auth/exchange`
- `POST /api/auth/refresh`
- `GET /api/user/profile`
- `GET /api/user/quota`
- `GET /api/models/available`

`/api/auth/exchange` 或 `/api/user/profile` 可以直接返回 `enterpriseContext`、`accountContext` 或 `organizationContext`。如果未内嵌，客户端会在 token 保存后调用 `/api/enterprise/context` 补齐。

refresh token 必须保留原 `accountMode` 和 `enterpriseId`；客户端在刷新请求中也会携带已持久化上下文头用于一致性检查。

### 企业模型调用

LobsterAI 服务端模型仍通过：

- `POST /api/proxy/v1/chat/completions`
- 其他 `/api/proxy/v1/*` 兼容端点

客户端的本地 token proxy 会同时转发 Bearer token 和当前企业上下文头。企业租户鉴权及扣费仍由服务端根据 token 完成。

### 结构化额度错误

服务端在模型请求失败时返回统一错误结构，并保留以下错误码：

| code | reason | 客户端行为 |
|---:|---|---|
| `41606` | 成员月度额度已用完 | 任务内显示成员额度提示；管理员可进入额度调整页 |
| `41607` | 企业积分池已用完 | 任务内显示企业额度提示；管理员可进入后台或充值 |
| `41608` | 企业积分批次全部过期 | 单独说明积分已过期；管理员可进入后台或充值 |

示例：

```json
{
  "code": 41607,
  "message": "企业积分池已用完",
  "data": null
}
```

客户端将错误保存为结构化消息元数据：

```json
{
  "enterpriseErrorCode": 41607,
  "enterpriseQuotaReason": "enterprise_pool_exhausted"
}
```

提示逻辑只读取结构化错误码/原因，不通过错误文案推断角色或额度类型。

## Frontend Action Items

已在 LobsterAI 客户端实现：

1. 使用 `src/shared/enterpriseAccount/` 维护跨主进程/渲染进程契约。
2. 使用 `src/main/enterpriseAccount/` 持久化和刷新账号上下文。
3. 使用 `src/main/ipcHandlers/enterpriseAccount/` 暴露只读上下文 IPC。
4. 使用 `src/renderer/features/enterpriseAccount/` 管理 Redux 状态、企业账号菜单和任务中额度提示。
5. 登录、刷新、退出和身份切换时同步清理企业上下文、额度展示及服务端模型缓存。
6. Portal 跳转使用以下页面：
   - 企业后台：`#/enterprise/console/{enterpriseId}/overview`
   - 当前身份用量概览：`#/enterprise/profile/{enterpriseId}`
   - 管理员用量与额度：`#/enterprise/console/{enterpriseId}/usage`
   - 充值：`#/enterprise/console/{enterpriseId}/recharge`

普通成员不显示企业后台、充值或调整额度入口。超级管理员入口仍按服务端 `permissions` 再次控制；前端隐藏不替代服务端鉴权。
多企业列表中，超级管理员企业打开管理后台，普通成员企业打开企业个人页；该跳转不替换客户端现有 access/refresh token，也不改变当前扣费企业。

## Auth Requirements

- `/api/enterprise/context` 和 `/api/proxy/*` 使用 Electron JWT Bearer 认证。
- 最终 token 必须由 Portal 身份选择流程签发并绑定企业租户。
- `enterpriseId` 请求头只用于上下文一致性检查，不能作为服务端租户授权依据。
- `41600`、`41602`、`41612` 表示本地企业上下文失效；客户端会清除企业上下文，用户需要重新登录或重新选择身份。

## Notes & Caveats

- 新任务页使用 LobsterAI 服务端模型时，根据 `/api/enterprise/context.quotaStatus` 预先展示额度卡片并禁用提交，不显示中断横线；用户自配模型不消耗企业额度，因此不受该状态限制。任务执行收到 `41606`、`41607` 或 `41608` 后展示中断横线与额度卡片。
- 个人账号保留原个人额度、充值、邀请活动和账号菜单逻辑。
- 企业账号不请求个人 `profile-summary`，避免将个人积分明细误显示为企业额度。
- 服务端应先上线企业上下文、token 绑定、模型可见性和结构化额度错误，再发布客户端。
- 生产企业控制台域名应由既有 Portal 环境配置确定；客户端不拼接未知域名。
