# 资料库云端聚合接口联调说明

> 日期：2026-08-17
>
> 最近更新：2026-09-04
>
> 涉及仓库：`LobsterAI`、`lobsterai-server`、`lobsterai-admin`；2026-09-04 的订阅恢复入口增量只涉及前两者，`lobsterai-portal` 与 `lobsterai-admin` 无必改项
>
> 数据库兼容：MySQL 5.7
>
> 合同状态：云端列表与 lineage 为现有联调合同；分享文件永久删除已完成三端代码实现，待 NOS 物理删除消费闭环验证后才能正式开放；本文的分享文件访问分析（owner analytics API）状态保持原合同说明；免费过期资源的恢复能力字段、CTA、客户端转化埋点和订阅返回刷新已完成客户端与服务端实现

## 范围与数据边界

资料库由客户端聚合两类数据：

- 本地产物由 Electron 主进程读取本机文件和本地 SQLite 索引，不上传文件路径、文件内容、缩略图、本地收藏或完整会话关系；
- 分享文件和部署站点由服务端已有 `html_shares`、`share_deployments` 数据提供；
- 收藏全部保存在客户端 SQLite，服务端不新增收藏表或收藏接口；
- 服务端不新增本地产物主表，也不判断本地文件是否存在。

本期服务端已有以只读投影为主的云端聚合接口，并补齐现有分享更新接口对最新 `sessionId/artifactId` 的持久化；唯一受控副作用是有效个人订阅请求无 cursor 第一页时调用既有幂等恢复兜底，带 cursor 续页不触发。分享文件永久删除接口、客户端交互和管理员后台 `deleted` 隔离已完成实现。删除复用现有 `html_shares` 墓碑和 NOS 删除队列表，不新增核心 DDL。分享文件访问分析（owner analytics API）的状态沿用下文说明，与恢复 CTA 客户端转化埋点是两套不同数据。

2026-09-04 增量只为现有分享/站点所有者响应增加可选恢复能力投影，并在 Electron 中增加套餐入口与恢复后的权威刷新。它不新增写接口、不改变分享状态机、不新增数据库表/列/索引，也不要求 Portal 或 Admin 改造。

## 发布顺序

### 既有资料库、分析与永久删除基线

1. 先发布包含云端列表、分享 owner analytics、永久删除接口、deleted 查询隔离和 lineage 修复的 `lobsterai-server`；旧 `DELETE /api/html-shares/{shareId}` 必须继续表示停止分享；
2. 发布 `lobsterai-admin`，确认默认列表不显示 deleted，显式“已删除”筛选只能查看最小审计信息；
3. 在测试环境使用个人账号和企业账号分别校验 owner 隔离、游标、站点状态、分享分析和永久删除数据库语义；
4. 确认仓库外 NOS 消费者，或另行实现兼容 MySQL 5.7 的可靠消费者，并验证真实对象删除、重试、积压年龄和告警；该步骤未完成时不得正式开放永久删除入口；
5. 发布带资料库入口的 Electron 客户端；旧客户端继续使用现有分享与站点接口，不受影响；
6. 分享分析入口通过客户端功能开关在 owner analytics 上线后开放；接口 404/`FEATURE_UNAVAILABLE` 时只隐藏分析入口，不回退调用 Admin 接口；
7. 新客户端连接尚未升级的服务端时，本地产物仍可使用，云端区域显示来源级错误和重试入口。

### 2026-09-04 订阅恢复入口增量

1. 先发布返回可选 `subscriptionRecoveryMode`、补齐 Library/Site 投影列和公网暂停文案的服务端；旧客户端会忽略新增 JSON 字段；
2. 再发布透传恢复模式、展示浅色黑底白字/深色白底黑字的高对比 CTA、上报恢复入口转化埋点、强制首个回焦订阅检查和账号级恢复协调器的 Electron 客户端；
3. 服务端回滚后，新客户端将缺失、`null` 或未知模式按 `none` 处理并隐藏入口；客户端回滚后，服务端无需撤销字段；
4. 本增量没有数据库发布步骤，V77 `access_expires_at` 属于已经落地的额度/过期基线，不在本次修改或重复执行。

## 鉴权与账号归属

客户端主进程使用现有发布请求上下文携带 Bearer JWT，Renderer 不读取或持久化 JWT。服务端通过 `PublishingAccountContextResolver` 解析：

- `userId`；
- `accountMode`；
- 企业模式下的 `enterpriseId`。

接口不接受客户端传入用户 ID、账号模式或企业 ID。个人资料和企业资料严格按当前发布账号隔离。

## 云端资料列表

### 请求

```http
GET /api/library/cloud-items?kind=all&category=all&sharedStatus=all&keyword=&cursor=&pageSize=24
Authorization: Bearer <token>
```

| 参数 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `kind` | 否 | `all` | `all \| shared_file \| deployed_site` |
| `category` | 否 | `all` | `all \| web \| slides \| document \| spreadsheet \| image \| media \| other` |
| `sharedStatus` | 否 | `all` | `all \| live \| disabled`；非 `all` 时只允许与 `kind=shared_file` 一起使用 |
| `keyword` | 否 | 空 | 去除首尾空白后最多 100 个 Unicode code point；匹配标题、入口文件名和资源 ID |
| `cursor` | 否 | 空 | 服务端返回的不透明 Base64URL 游标，最长 2048 字符 |
| `pageSize` | 否 | `24` | 小于等于 0 时回退默认值，最大 100 |

统一响应外层：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "serverNow": 1786933200000,
    "recoveryPending": false,
    "list": [],
    "nextCursor": null,
    "hasMore": false,
    "counts": {
      "sharedFile": 0,
      "deployedSite": 0
    },
    "sharedStatusCounts": {
      "all": 0,
      "live": 0,
      "disabled": 0
    }
  }
}
```

`serverNow` 与 `recoveryPending` 均为向后兼容字段。`serverNow` 是本次响应生成时的 Unix epoch 毫秒；`recoveryPending` 只供有效个人订阅账号在无 cursor 第一页触发恢复兜底后做 3/10/30 秒有界重试，已停止 Node 服务不计入 pending。旧服务端缺失时客户端不得猜测。

`counts` 应用当前 `category` 和 `keyword`，但不应用 `kind`，用于同一查询条件下展示“分享文件/部署站点”来源数量。

`sharedStatusCounts` 同样应用当前 `category` 和 `keyword`，但不应用当前 `sharedStatus`，用于分享文件页的“全部/已打开/已关闭”筛选数量。列表筛选和两组计数均由服务端 SQL 完成，客户端不能用当前页数据推导全量数量。

### 普通分享项

```json
{
  "itemKind": "shared_file",
  "itemId": "share-id",
  "title": "产品方案.pdf",
  "url": "https://example/share-id",
  "category": "document",
  "sourceType": "document_file",
  "entryFile": "产品方案.pdf",
  "accessMode": "public",
  "status": "live",
  "disabledSource": null,
  "moderationStatus": "approved",
  "accessExpiresAt": 1786939800000,
  "effectiveAvailable": true,
  "effectiveExpiresAt": 1786939800000,
  "effectiveUnavailableReason": null,
  "subscriptionRecoveryMode": "automatic",
  "totalFiles": 1,
  "totalBytes": 102400,
  "sessionId": "local-session-id",
  "artifactId": "session-artifact-id",
  "clientSourceKey": "sha256-key",
  "createdAt": "2026-08-17T10:00:00",
  "updatedAt": "2026-08-17T10:10:00",
  "contentUpdatedAt": "2026-08-17T10:10:00",
  "sortTime": 1786932600000
}
```

普通分享只包含以下来源，和部署站点互斥：

```text
html_file
image_file
svg_file
document_file
markdown_file
mermaid_file
```

普通分享列表只返回 `live` 和 `disabled` 两种原始可管理状态；`failed`、`deleted` 不进入资料库分享文件页。服务端不新增独立的原始 `expired` 状态，而是通过 `accessExpiresAt`、`effectiveAvailable`、`effectiveExpiresAt`、`effectiveUnavailableReason` 和列表级 `serverNow` 表达期限及当前可访问性。`disabledSource` 可能为 `user \| admin \| moderation \| active_limit \| system`，但它只描述关闭来源：`system` 不能单独证明资源可通过订阅恢复，CTA 必须使用 `subscriptionRecoveryMode`。

### 部署站点项

```json
{
  "itemKind": "deployed_site",
  "itemId": "share-id",
  "title": "产品官网",
  "url": "https://example-site",
  "category": "web",
  "sourceType": "static_service_deployment",
  "entryFile": "index.html",
  "accessMode": "public",
  "status": "live",
  "shareStatus": "live",
  "disabledSource": null,
  "siteKind": "static_site",
  "siteStatus": "online",
  "deploymentId": "deployment-id",
  "deploymentStatus": "live",
  "accessExpiresAt": 1786939800000,
  "effectiveAvailable": true,
  "effectiveExpiresAt": 1786939800000,
  "effectiveUnavailableReason": null,
  "subscriptionRecoveryMode": "automatic",
  "sessionId": "local-session-id",
  "artifactId": "session-artifact-id",
  "clientSourceKey": "sha256-key",
  "createdAt": "2026-08-17T10:00:00",
  "updatedAt": "2026-08-17T10:10:00",
  "sortTime": 1786932600000
}
```

站点状态计算复用 `SiteMapper.siteStatusExpression`，必须与现有 `/api/sites` 列表保持一致。每个 `shareId` 只选择一条最新部署记录，优先级为 `active DESC, created_at DESC, id DESC`。

### 有效状态与订阅恢复能力

所有者接口新增可选字段：

```text
subscriptionRecoveryMode: automatic | redeploy_required | none
```

新服务端在 owner 响应中固定输出三种小写值之一；字段只因滚动发布、旧服务端和回滚场景而保持可选。

它描述“当前 owner 的订阅生效后，该资源如何恢复”，不替代 `effective*`，也不是“已经过期”标记。安全白名单内的固定时限资源在到期前可以预先返回 `automatic/redeploy_required`，使页面停留跨过截止时间时无需请求服务端也能出现入口。客户端只有同时满足以下条件才展示购买 CTA：

1. 当前发布账号为个人普通账号；
2. 固定截止时间按 `serverNow + monotonic elapsed` 已到且资源当前不可访问；
3. 模式为 `automatic` 或 `redeploy_required`。

恢复矩阵：

| 资源状态 | 模式 |
| --- | --- |
| 固定时限文件仍为 `live`，或仅因 `free access expired` 关闭 | `automatic` |
| 固定时限网站的分享与最新 deployment 均仍 `live/active` | `automatic` |
| 固定时限静态网站的分享仍为 `live` 或仅因免费到期关闭，且最新 deployment 为 stopped/expired inactive、静态来源仍完整 | `automatic` |
| 固定时限 Node 的分享仍为 `live` 或仅因免费到期关闭，且最新 deployment 为 stopped/expired inactive；无论截止时间是否已到 | `redeploy_required` |
| 用户、管理员、审核、活跃额度或未知原因关闭；`failed/deleted`；企业资源；`entitlement_grace_expired` | `none` |

站点必须先分类最新 deployment 类型、`status/active` 与分享关闭状态，不能因为 `shareStatus=live` 就把已经停止的 Node 误报为 `automatic`。`automatic` 与自动恢复候选一一对应；stopped Node 只返回 `redeploy_required`，到期前仍沿用既有免费重新部署操作、不展示订阅 CTA。`subscriptionRecoveryMode` 的服务端 resolver 应与候选共用常量和测试矩阵；Library 聚合 SQL 一次性 SELECT 所需的 `disabled_reason/access_expires_at/deployment status/active`，禁止为每条记录补查形成 N+1。本变化只扩展 SELECT 和 DTO，不增加 DDL。

客户端收到字段缺失、`null` 或未来未知枚举时按 `none`。Library 类型、Main/Preload 传输和详情合并必须保留显式 `null`：文件与云端项的 `accessExpiresAt: null`、部署详情的 `expiresAt: null` 都要清除旧过期快照，不能用 `newValue ?? oldValue` 留住旧值。

CTA 点击后继续打开现有 Portal `#/pricing`：文件使用 `keyfrom=html_share`，网站使用 `keyfrom=site_deployment`，可选 `trace_id` 放在 hash 查询内。返回 Electron 后，由不依赖 Library 页面挂载的账号级协调器执行一次不受 30 秒节流限制的订阅检查；同一 owner 成为 active，或冷启动时已经 active 但资源仍为 `automatic`，均请求云端无 cursor 第一页。`recoveryPending=true` 时只按 3/10/30 秒重试，每轮刷新目标详情并使 owner 对应的 Library 查询失效，直到服务端返回权威可访问状态及对应期限字段为 `null`。目标页面离开只移除该详情刷新订阅，不终止同 owner 的 cloud 恢复批次；账号切换、登出、恢复完成或重试耗尽才清理账号级协调器。

### 客户端恢复 CTA 转化埋点

这里的埋点是在 Electron 客户端产生、通过 `reportYdAnalyzer` 上传到分析服务端的产品事件，不是 `lobsterai-server` 进程日志，也不是分享访问分析 API。它沿用现有客户端上报链路，不需要新增 `lobsterai-server` 业务接口或数据库字段。完整五 surface 合同见 [`2026-08-20-publishing-quota-expiration.md`](./2026-08-20-publishing-quota-expiration.md)；本 Library 联调需保证：

- 列表、文件详情和站点详情分别使用 `recoverySurface=library_cloud_list/library_file_detail/library_site_detail`，上报 `lobsterai_publishing_recovery_cta_exposure` 与 `lobsterai_publishing_recovery_cta_action`；
- 列表使用 `source=library_list, entryPoint=subscription_recovery_cta`，两个详情使用 `source=library_preview, entryPoint=library_settings`；新 `recoverySurface` 不覆盖旧 `surface`；
- 共同字段固定 `interactionType=recovery_cta`、`operationType=subscription_recovery`、`identityType=free`，并带 `subscriptionRecoveryMode`、`feature/resourceKind`、`attemptId/exposureId`；点击固定 `ctaId=primary`、`target=pricing` 并生成 `operationId`；
- 同一曝光周期的 `attemptId` 必须等于 Portal `trace_id`，并被七天 last-touch 与既有 `lobsterai_publishing_subscription_observed` 继续回传；
- 列表行进入可视区才产生曝光，倒计时、查询刷新、有界轮询和虚拟列表重挂载不得重复上报；
- owner/resource key 只在本地归因 envelope 中用于隔离和去重，上报 payload 必须按白名单构造，禁止整体展开本地记录；不上传 `ownerAccountKey`、`resourceKey`、`itemId/shareId/siteId/deploymentId`、文件名、路径、URL、分享码、任务标题、搜索词或资源内容；
- `subscription_observed` 只表示七天 last-touch 内同一 personal owner 被客户端权威 auth/quota 快照观察为 `subscriptionStatus=active` 且事件上传成功，不代表 Portal 订单支付成功，也不代表 Library 资源已恢复；
- 恢复结果单独上报 `lobsterai_publishing_recovery_result`；`automatic` 只在权威响应已可访问且期限为 `null` 时记 `outcome=restored`，`redeploy_required` 订阅生效后记 `outcome=redeploy_ready`。

所有事件遵守 `usageAnalyticsEnabled`，上报失败不阻断打开套餐页。

### 排序和游标

服务端稳定排序为：

```text
sort_at DESC, item_kind DESC, item_id DESC
```

游标编码并校验相同三个字段：

```json
{
  "sortTime": 1786932600000,
  "itemKind": "shared_file",
  "itemId": "share-id"
}
```

客户端必须把 `cursor` 当作不透明字符串，不自行构造。SQL 使用派生表、`UNION ALL`、相关子查询和显式比较谓词，不使用 CTE、窗口函数、`JSON_TABLE` 或 MySQL 8 专属语法。

## 分享更新 lineage

现有接口保持路径和 multipart 语义不变，仅增加两个可选字段：

```http
PUT /api/html-shares/{shareId}
Content-Type: multipart/form-data

sessionId=<current local session id>
artifactId=<current session artifact id>
title=...
entryFile=...
accessMode=...
sourceSha256=...
clientSourceKey=...
archive=<file>
```

兼容规则：

- 新客户端传入非空 `sessionId/artifactId` 时覆盖为本次发布来源；
- 参数缺失、空字符串或只有空白时保留数据库原值；
- 旧客户端无需修改，不能因缺少新字段把原 lineage 清空；
- 服务端分别按 128 字符上限规范化两个字段；
- 本地会话删除不会通知服务端，客户端展示云端项时只在本机会话仍存在时建立跳转，否则按云端资料展示。

## 分享文件访问分析

### 接口状态与用途

以下为待实现、需要在客户端分析入口开放前冻结的 owner 合同。现有 `AdminHtmlShareController` 统计接口只供后台审核，不允许客户端直接调用；owner 响应不得包含脱敏 IP、User-Agent、Referer 或来源维度。

```http
GET /api/html-shares/{shareId}/analytics?from=2026-08-13&to=2026-08-19
Authorization: Bearer <token>
```

服务端使用 `PublishingAccountContextResolver` 解析当前个人/企业发布账号，并校验该账号拥有 `shareId`。接口只接受云端列表定义的普通分享来源；当前 owner 传入部署来源时返回 `INVALID_PARAMETER`，部署站点继续调用现有：

```http
GET /api/sites/{shareId}/analytics
```

### 日期参数

| 参数 | 必填 | 约束 |
| --- | --- | --- |
| `from` | 否 | `yyyy-MM-dd`；与 `to` 同时省略时默认为过去 7 个自然日（含今天） |
| `to` | 否 | `yyyy-MM-dd`；以服务端统计时区的今天为上限 |

以下情况复用 `INVALID_PARAMETER`：只传单侧日期、日期格式错误、`from > to`、`to` 晚于今天或范围包含超过 31 个自然日。服务端不接受客户端传时区；响应 `meta.timeZone` 返回实际统计时区。

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "summary": {
      "accesses": 128,
      "uniqueVisitors": 46
    },
    "trend": [
      {
        "date": "2026-08-13",
        "accesses": 20,
        "uniqueVisitors": 8
      },
      {
        "date": "2026-08-14",
        "accesses": 0,
        "uniqueVisitors": 0
      }
    ],
    "meta": {
      "from": "2026-08-13",
      "to": "2026-08-19",
      "granularity": "day",
      "timeZone": "Asia/Shanghai",
      "dataScope": "share_lifetime",
      "visitorMetric": "ip_hash_estimate",
      "retentionDays": 180,
      "dataAvailableFrom": "2026-06-01"
    }
  }
}
```

合同约束：

- `trend` 按日期升序覆盖请求范围的每一天，缺失日期由 Service 补 0；
- `summary.accesses` 为范围内所有有效入口文件请求总数；
- `summary.uniqueVisitors` 在整个范围内对 `ip_hash` 去重，同一访客跨天只计一次，不能用每日独立访客相加；
- `trend[].uniqueVisitors` 是各自然日内的去重值；
- `retentionDays/timeZone` 读取当前服务端配置，客户端不硬编码；
- `dataAvailableFrom` 为该分享当前保留数据的最早日期，无数据时允许为 `null`；
- 无数据是成功响应，摘要和完整趋势均为 0；分享为 `disabled` 时仍可读取停用前历史。

### 统计口径

当前 V52 采集链路记录通过访问校验后的入口文件请求：

- 计入：公开访问或分享码校验成功后的入口文件请求；
- 不计入：分享码输入页、被拒绝/失败的请求、静态依赖资源、管理员预览；
- 所有者通过普通公共链接访问按普通访客计数；通过管理端预览不计数；
- 当前链路不能可靠区分浏览、预览与下载，所以 UI 和 API 使用 `accesses/访问次数`，不命名为下载量或页面浏览量；
- 独立访客是 HMAC 后 IP 的估算值，同网出口、代理和 IP 变化会影响精度。

分析数据按稳定 `shareId` 覆盖整个分享生命周期。文件更新可能生成新的 `source_sha256/content_updated_at`，owner analytics 必须汇总全部内容版本；现有后台 `getAccessTrend()` 绑定当前版本，不能直接复用，否则更新内容后历史会归零。

### MySQL 5.7 查询

不新增表或列，复用：

- `html_share_access_stats`；
- `html_share_ip_access_stats`；
- `html_share_access_dimension_stats`（首期 owner 接口不读取）。

Mapper 增加跨内容版本查询：

```sql
SELECT stat_date,
       SUM(total_access_count) AS accesses
FROM html_share_access_stats
WHERE share_id = #{shareId}
  AND stat_date BETWEEN #{from} AND #{to}
GROUP BY stat_date
ORDER BY stat_date ASC;

SELECT stat_date,
       COUNT(DISTINCT ip_hash) AS unique_visitors
FROM html_share_ip_access_stats
WHERE share_id = #{shareId}
  AND stat_date BETWEEN #{from} AND #{to}
GROUP BY stat_date
ORDER BY stat_date ASC;

SELECT COUNT(DISTINCT ip_hash) AS unique_visitors
FROM html_share_ip_access_stats
WHERE share_id = #{shareId}
  AND stat_date BETWEEN #{from} AND #{to};
```

访问次数范围合计可在 Service 层使用 `long` 汇总第一条查询结果。日期补零在 Java 完成，不使用递归 CTE、窗口函数或 MySQL 8 专属语法。现有 `idx_html_share_access_share_date (share_id, stat_date)` 与 `idx_html_share_ip_access_top (share_id, stat_date, access_count)` 先作为范围过滤索引；`COUNT(DISTINCT ip_hash)` 必须在 MySQL 5.7 测试库执行 `EXPLAIN` 和 7/30 天量级压测，只有数据证明必要时再单独评审覆盖索引或预聚合。

### 客户端对接

1. `HtmlShareIpc` 增加集中定义的 `GetAnalytics = htmlShare:getAnalytics`；
2. Main 校验 `shareId/from/to` 后，由 `htmlShareClient` 携带现有发布鉴权请求服务端；
3. Preload 只暴露 analytics 所需最小方法和共享响应类型；
4. Renderer 使用 `ownerScope + shareId + from + to` 作为 queryKey，忽略迟到响应；
5. 分析页默认 7 天，可切换 30 天，只显示独立访客、访问次数和趋势，不显示热门页面；
6. 分析请求失败局部重试，不清空设置详情或云端列表。

## 分享文件永久删除

### 接口与兼容边界

```http
DELETE /api/html-shares/{shareId}/permanent
Authorization: Bearer <token>
```

成功和同 owner 重复删除都返回：

```json
{
  "code": 0,
  "message": "success",
  "data": null
}
```

旧接口 `DELETE /api/html-shares/{shareId}` 继续只把分享切换为 `disabled`，不能被新客户端当作永久删除。部署站点继续使用 `DELETE /api/sites/{shareId}`，不得通过 `/permanent` 绕过 Site 状态机。

服务端从当前鉴权请求解析 `PublishingAccountContext`，不接受 Renderer 传 `userId/accountMode/enterpriseId`。可删除来源固定为：

```text
html_file
image_file
svg_file
document_file
markdown_file
mermaid_file
```

| 当前记录 | 结果 |
| --- | --- |
| 当前 owner、普通分享、`status = disabled` | 执行永久删除事务 |
| 当前 owner、同一普通分享已为 `deleted` | 幂等成功 |
| 当前 owner、普通分享仍为 `live` | `41315 HTML_SHARE_DELETE_REQUIRES_DISABLED` |
| 事务条件不再匹配 | `41316 HTML_SHARE_ACTION_CONFLICT`，客户端保留资源并刷新 |
| 站点来源、其他 owner、不存在 | 统一按 owner 不可见/不存在处理，不泄露资源是否存在 |

客户端只在分享设置页底部显示危险区域。`live` 时不自动串联“停止 + 删除”；`disabled` 时要求输入当前显示文件名，输入去除首尾空格后仍需逐字符完全一致。确认文案必须说明：云端分享和访问数据不可恢复，本地原文件及相关任务不受影响，免费用户累计历史分享名额不会因删除释放。

### 服务端事务与墓碑

一个数据库事务完成以下步骤：

1. 按 `shareId + userId + accountMode + enterpriseId` 查询并 `FOR UPDATE`；
2. 校验普通来源与 `disabled/deleted` 状态；
3. 快照当前 `html_share_files`，使用同步入口 `INSERT IGNORE` 写入 `html_share_nos_delete_files`，原因为 `shared_file_deleted`；队列写入失败时整个事务回滚；
4. 删除 `html_share_files`、每日/IP/维度访问统计和访问复核触发记录，并清空审核明细中的路径、内容哈希、原因、密钥别名和原始响应；
5. 条件更新 `html_shares` 为最小 `deleted` 墓碑后提交。

墓碑只保留 owner、`shareId`、普通来源类型、`sourceSha256`、创建时间、原公共 URL 和删除审计。标题改为固定哨兵，入口改为 `__deleted__`；lineage、`clientSourceKey`、分享码凭证、访问截止时间、最后访问时间和内容更新时间清空。`disabledAt/disabledByUserId/disabledReason/updatedAt` 记录删除时间、执行用户和固定内部原因。原 `shareId` 永不复用。

常规 owner 列表、详情、analytics、公共访问、更新、权限与状态接口均把 deleted 当作不存在；访问统计、最后访问和审核异步写带状态/内容版本条件，不能在删除事务提交后重新生成子数据。

### 列表、配额与管理员后台

- 资料库和 `/api/html-shares/my` 不返回 deleted，可见 `counts.sharedFile` 和 `sharedStatusCounts` 在删除后减少；
- 免费个人账号的累计创建限制继续使用 `status <> 'failed'`，因此 deleted 仍计入历史用量。例如 10/10 删除一条后仍是 10/10，不能创建第 11 条；
- 订阅和企业活跃额度在停止分享时已经释放，永久删除不再次调整或补位；
- `lobsterai-admin` 未传 `status` 时默认增加 `status <> 'deleted'`；显式选择“已删除”只展示墓碑安全字段和删除时间，不能预览、审核、恢复、修改权限或下载文件；
- `lobsterai-portal` 没有分享文件管理入口，本功能不增加重复入口。

### NOS 物理删除发布 Gate

当前仓库已保证 NOS 删除意图与 deleted 墓碑在同一事务提交，但仓库内仍未发现消费 `html_share_nos_delete_files.status = 'pending'` 并调用 NOS 删除的任务，也没有可据此安全实现删除的 NOS API 合同。因而当前接口完成的是：分享立即不可访问、数据库内容清理、NOS 对象删除可靠排队；不能宣称对象存储字节已经物理删除。

正式开放前必须确认现有外部消费者，或另项实现带原子抢占、幂等删除、失败重试、陈旧任务回收、积压年龄指标和告警的 MySQL 5.7 兼容消费者。测试环境必须能把 `shared_file_deleted` 任务推进到成功终态，并验证对应 NOS 对象实际不存在。该闭环不允许通过猜测上传 URL 对应的删除协议来补实现。

## 错误和降级

- 未登录或鉴权失效：沿用现有统一鉴权响应；客户端只禁用云端来源，本地产物继续可用；
- 非法 `kind/category/sharedStatus/cursor`，或把非 `all` 的 `sharedStatus` 与非 `shared_file` 的 `kind` 组合：返回现有 `INVALID_PARAMETER`；
- 云端网络错误或 5xx：客户端显示云端来源级错误和重试，不清空本地产物；
- 单条服务端数据字段异常：客户端丢弃该条记录，不影响其他资料；
- `media` 分类首期可以为空，不代表支持尚未发布的音频分享格式。
- 分享分析日期非法：`INVALID_PARAMETER`；客户端保留当前分析数据并恢复到最后有效范围；
- 分享分析没有历史数据或统计采集未启用：成功返回全 0 和真实 `meta`，不返回 5xx；
- 分享分析资源不属于当前账号、已删除或切换账号：沿用 owner 详情不可见语义，客户端返回云端列表并清理该资源缓存；
- 分享分析网络/5xx：只影响分析区，分享设置、本地产物和其他云端资源继续可用。
- 永久删除返回 `41315`：保留设置页并提示先停止分享，不能自动发起停止操作；
- 永久删除返回 `41316`：保留资源并刷新权威详情/列表，不自动重试写操作；
- 永久删除成功：退出详情、清理该资源的本地收藏和缓存、更新可见计数并刷新云端第一页；本地文件和任务不变；
- 新客户端遇到没有 `/permanent` 路由的旧服务端：不得乐观移除本地列表项，应保留资源并提示服务端版本不支持。
- 旧服务端不返回 `subscriptionRecoveryMode/serverNow/recoveryPending/effective*`：客户端保持既有展示并隐藏恢复 CTA，不能从 `disabledSource` 或中文/英文原因猜测；未知恢复枚举同样按 `none`。

## 数据库与上线核对

本期不执行迁移 SQL，也不新增索引；2026-09-04 恢复入口增量同样没有 DDL。上线前应在 MySQL 5.7 测试库完成：

1. 个人、企业账号各准备普通分享和两种部署站点；
2. 校验普通分享与站点互斥、已删除记录不可见；
3. 校验相同 `sort_at` 下翻页不重不漏；
4. 校验 `share_id` mixed collation 连接与现有 Sites 查询一致；
5. 使用 `EXPLAIN` 观察 owner/source 条件和最新 deployment 子查询；
6. 为同一分享准备多个内容版本和跨天重复 IP，校验访问总数跨版本求和、范围独立访客跨天/跨版本去重；
7. 使用 `EXPLAIN` 观察 7/30 天分享分析查询，重点检查 `COUNT(DISTINCT ip_hash)` 的扫描行数、临时表和延迟；
8. 校验 disabled 分享可读历史、站点来源拒绝、owner 响应不包含 IP/UA/Referer；
9. 校验永久删除只接受当前 owner 的 disabled 普通分享，live 为 `41315`，同 owner 重复删除幂等，站点和其他 owner 不可见；
10. 校验 deleted 不进入普通列表、详情、analytics 和公共访问；文件/统计子表已清理、审核敏感字段已脱敏，迟到写不能复活数据；
11. 用免费账号验证 10/10 删除后仍为 10/10，9/10 删除后仍为 9/10；可见列表计数应减少，但累计创建配额不减少；
12. 跟踪 `shared_file_deleted` 队列到成功终态并确认 NOS 对象不存在；消费者、重试或告警未验证时阻止正式开放；
13. 只有在真实数据量证明必要时另行评审索引，不能在本功能中直接增加未经验证的生产索引。
14. 校验 Library/Site 一次查询即可取得恢复投影所需列，分页不会产生 N+1；人工关闭、审核关闭、额度关闭和权益宽限结束均返回 `none`。
15. 校验旧客户端忽略新增字段，新客户端面对字段缺失/`null`/未知值隐藏 CTA；恢复完成时 `accessExpiresAt/expiresAt` 的显式 `null` 能清除客户端旧状态。

客户端转化埋点另行联调：三个 Library surface 的曝光/点击字段正确，`attemptId=trace_id`，rerender/轮询/虚拟列表重挂载不重复曝光，同 owner 七天订阅观察只成功上报一次；换账号、关闭使用分析和隐私 payload 检查通过。该联调不连接或改写数据库。

前序永久删除实现的历史验证记录为：服务端曾使用 JDK 17 完成 `compileJava`、`compileTestJava` 与 Mapper XML 语法校验；客户端永久删除目标测试、changed-file ESLint、Electron 编译和生产构建曾通过；管理员后台类型检查、目标 ESLint 和生产构建曾通过。MySQL 5.7 实库事务、配额和 NOS 消费验证仍按上述清单执行。

2026-09-04 订阅恢复入口增量已完成客户端与服务端实现。客户端目标 ESLint、目标 Vitest、`npm run build` 和 `npm run compile:electron` 已通过；服务端 `compileJava`、`compileTestJava`、Mapper XML 语法检查及差异格式检查已通过。按约定未运行依赖 Redis/外部发布服务的完整服务端测试套件，未连接数据库；Electron 手工 UI 和真实测试环境定向联调尚未执行。
