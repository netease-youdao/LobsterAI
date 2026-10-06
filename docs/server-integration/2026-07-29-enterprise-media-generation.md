# 企业账号生图/生视频接入说明

日期：2026-07-29

## Change Summary

`lobsterai-server` 的图片、视频生成链路现在识别 JWT 中绑定的企业账号上下文。有效企业的普通成员和超级管理员都拥有媒体生成权益；任务提交前预占成员月度额度和企业积分池，成功后按实际消耗结算，明确失败后释放预占。

本次契约的关键变化：

- `/api/user/quota` 新增权威字段 `mediaGenerationEntitled`。企业账号不再通过个人订阅状态推导媒体权益。
- 图片、视频模型列表和任务接口按 `personal`、`enterprise:{enterpriseId}` 隔离。
- 图片、视频生成请求支持 `Idempotency-Key`，新客户端必须发送。
- 企业媒体任务返回 `accountMode`、`billingScope`、`billingStatus` 和 `estimatedCredits`。
- 企业额度不足继续使用 `41606`、`41607`、`41608`；企业 token 上下文异常使用 `41612`。
- 企业任务只消耗企业积分，不会回退到个人订阅、免费积分、邀请积分或个人加油包。

个人账号现有媒体权益和计费逻辑保持不变。

## Endpoint Details

所有接口继续使用统一响应结构：

```json
{
  "code": 0,
  "message": "success",
  "data": {}
}
```

### 媒体权益

`GET /api/user/quota`

企业账号响应示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "planName": "企业版",
    "subscriptionStatus": "enterprise",
    "mediaGenerationEntitled": true,
    "hasPaidCredits": true,
    "accountMode": "enterprise",
    "enterpriseId": 1001,
    "creditsLimit": 5000,
    "creditsUsed": 1200,
    "creditsRemaining": 3780
  }
}
```

字段语义：

- `mediaGenerationEntitled` 是媒体权益的权威字段。显式 `false` 必须覆盖所有旧兼容判断。
- `hasPaidCredits` 只为旧版客户端保留兼容，不代表个人订阅，也不能用于判断账务归属。
- `subscriptionStatus` 保持 `enterprise`，不得按个人订阅的 `active` 处理。
- 企业额度不足时，`mediaGenerationEntitled` 仍为 `true`；能否立即提交由企业 `quotaStatus` 决定。
- 企业服务端尚未返回 `mediaGenerationEntitled` 时，企业客户端必须 fail closed，不能回退个人订阅购买入口。

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
    "mediaGenerationEntitled": true,
    "memberQuota": {
      "limit": 5000,
      "used": 1200,
      "reserved": 20,
      "remaining": 3780
    },
    "enterprisePool": {
      "total": 100000,
      "used": 30000,
      "remaining": 69980
    },
    "quotaStatus": {
      "available": true,
      "reason": null,
      "errorCode": null
    }
  }
}
```

`memberQuota.remaining` 和 `enterprisePool.remaining` 都是已经扣除未完成媒体任务预占后的可用额度。客户端不得再次减去 `reserved`。

### 媒体额度

`GET /api/media/quota`

企业账号响应示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "accountMode": "enterprise",
    "mediaGenerationEntitled": true,
    "memberRemaining": 3780,
    "enterprisePoolRemaining": 69980,
    "availableCredits": 3780,
    "quotaStatus": {
      "available": true,
      "reason": null,
      "errorCode": null
    }
  }
}
```

`availableCredits` 等于成员剩余额度与企业积分池剩余额度的较小值。个人账号响应保持原有字段。

### 模型列表

- `GET /api/media/images/models`
- `GET /api/media/videos/models`

携带企业 token 时，服务端返回当前启用且面向企业账号公开的媒体模型。客户端模型缓存必须绑定当前账号，而不是仅按用户 ID 或媒体类型复用。

### 创建媒体任务

- `POST /api/media/images/generate`
- `POST /api/media/videos/generate`

请求头：

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
Idempotency-Key: <UUID>
X-LobsterAI-Account-Mode: enterprise
X-LobsterAI-Enterprise-Id: 1001
```

请求体保持原结构，不增加 `enterpriseId`：

```json
{
  "model": "example-media-model",
  "type": "image",
  "prompt": "一只在海边的龙虾",
  "params": {
    "size": "1024x1024"
  }
}
```

企业任务响应新增账务镜像字段：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "taskId": 10001,
    "model": "example-media-model",
    "type": "image",
    "status": "processing",
    "progress": 0,
    "accountMode": "enterprise",
    "billingScope": "enterprise",
    "billingStatus": "reserved",
    "estimatedCredits": 20,
    "createdAt": "2026-07-29T15:20:00"
  }
}
```

`Idempotency-Key` 规则：

- 新客户端每次用户发起的新生成操作创建一个 UUID；同一次网络重试必须复用原 key。
- key 最长 128 个字符。
- 唯一范围包含用户、账户、企业和媒体类型，因此个人账号、企业 A、企业 B 之间不会冲突。
- 相同 key 且请求内容相同会返回原任务，不会重复提交上游或重复预占。
- 相同 key 但请求内容不同会返回参数冲突。
- 服务端兼容旧客户端缺少该 header，但缺失时不保证跨网络重试幂等。

### 查询、列表与取消

- `GET /api/media/images/tasks`
- `GET /api/media/images/tasks/{taskId}`
- `POST /api/media/images/tasks/{taskId}/cancel`
- `GET /api/media/videos/tasks`
- `GET /api/media/videos/tasks/{taskId}`
- `POST /api/media/videos/tasks/{taskId}/cancel`

服务端按 `userId + accountMode + enterpriseId` 校验任务归属。同一用户在个人账号或其他企业创建的任务，对当前企业 token 不可见且不可取消。

## Frontend Action Items

1. 权益判断优先读取 `/api/user/quota.mediaGenerationEntitled`。企业账号缺少显式字段时禁用媒体生成，不显示个人订阅购买提示。
2. 企业账号同时要求当前企业上下文已加载、`enterpriseId` 匹配且 `quotaStatus.available=true`；权益与额度不能取自不同账号快照。
3. 账号隔离键使用：

   ```text
   personal:{userId}
   enterprise:{userId}:{enterpriseId}
   ```

   权益、额度、图片/视频模型缓存、当前模型选择和待轮询任务都必须绑定该键。
4. 个人与企业、企业 A 与企业 B 切换时增加账号 generation，清除或隔离旧账号媒体状态，并丢弃旧 generation 的延迟响应。
5. 每次新生成创建 `Idempotency-Key`；认证刷新或网络重试复用同一请求头。
6. 任务轮询和取消响应落入状态前，再次校验 `ownerAccountKey` 与账号 generation。切换账号后不得用新 token 继续查询旧账号任务。
7. 收到 `41606`、`41607` 或 `41608` 后刷新 `/api/user/quota` 和 `/api/enterprise/context`，展示企业额度处理入口，不跳转个人 `/pricing`。
8. 收到 `41612` 后清除失效企业上下文，停止相关任务轮询，并要求用户重新登录或重新选择身份。

## Enterprise Error Handling

| code | reason | 客户端行为 |
|---:|---|---|
| `41606` | `member_monthly_quota_exhausted` | 普通成员申请成员额度；超级管理员进入用量与额度页 |
| `41607` | `enterprise_pool_exhausted` 或 `enterprise_media_uncovered` | 普通成员联系管理员；超级管理员进入充值页 |
| `41608` | `enterprise_credit_batches_expired` | 提示企业积分已过期；超级管理员购买新企业包 |
| `41612` | 企业 token 账号模式或企业 ID 错配 | 清除本地企业上下文并重新登录/选择身份 |

媒体接口返回企业错误时，不得转换为个人订阅或个人加油包错误提示。

## Auth Requirements

- 生成、任务、取消和额度接口使用 Electron JWT Bearer 认证。
- `accountMode=enterprise` 和 `enterpriseId` 必须来自服务端签名的 access token；refresh token 换发后必须保持同一账号上下文。
- `X-LobsterAI-Account-Mode`、`X-LobsterAI-Enterprise-Id` 只用于上下文传递和一致性检查，不能覆盖 token，也不能切换扣费企业。
- 请求体、query string 和普通 header 中不得新增可选择 `enterpriseId` 或 `memberId` 的参数。
- 普通成员和 `super_admin` 使用相同媒体权益与计费链路。

## Migration, Rollout & Rollback

发布顺序：

1. 在服务端数据库执行 `sql/V65__enterprise_media_billing.sql`，完成历史媒体任务个人账务回填，并增加企业预占、分摊和用量字段。
2. 部署服务端账务与权益逻辑，但保持 `ENTERPRISE_MEDIA_ENABLED=false`。
3. 发布包含显式权益判断、账号缓存隔离、任务隔离和 `Idempotency-Key` 的客户端。
4. 在测试环境验证普通成员和超级管理员的图片、视频成功、失败、取消、重复请求、额度不足及跨账号切换。
5. 生产环境设置 `ENTERPRISE_MEDIA_ENABLED=true`，统一开放给所有有效企业成员。

回滚时先关闭 `ENTERPRISE_MEDIA_ENABLED`，仅阻止新企业媒体任务。已经预占或已提交上游的任务必须继续结算、退款或对账；不要删除新增表、回滚历史账务或把企业任务改扣个人积分。

## Notes & Caveats

- `mediaGenerationEntitled=true` 表示产品包含媒体能力，不等于当前可用额度大于零。
- 任务的最终实际积分可能与预估值不同；客户端只展示服务端账务状态，不自行扣减。
- 网络超时或上游提交结果未知时，服务端会保留预占等待对账。客户端不得把这类情况当作已退款。
- 企业媒体模型继续使用服务端全局媒体模型配置，一期没有逐企业或逐成员媒体开关。
