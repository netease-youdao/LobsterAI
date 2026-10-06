# 站点管理与访问分析服务端联调说明

## 范围

本期只涉及 LobsterAI Electron 客户端和 `lobsterai-server`，不涉及管理员后台。客户端通过主进程携带现有 Electron Bearer JWT 调用接口，Renderer 不接触或持久化 JWT。

## 发布顺序

1. 在目标数据库依次执行 `lobsterai-server/sql/V61__site_access_analytics.sql` 和 `V62__site_subscription_quota.sql`。
2. 校验当前环境四档 `site.quota.plan-limits.*` 配置，并确认配额锁与预留表存在。
3. 发布包含 `/api/sites`、配额预检和部署最终校验的服务端。
4. 验证服务端功能开关、站点 Host 流量采集及配额并发行为。
5. 发布带“站点”入口和超额替换弹窗的 Electron 客户端。

旧客户端不会调用新接口；既有 `/api/html-shares/*`、`/api/share-deployments/*` 和管理员接口保持兼容。

### 2026-08-26 页面访问排行纠偏发布顺序

1. 发布服务端共享文档导航分类器和静态缺失资源回退修复；
2. 验证首页、SPA 深链接、favicon、图片、脚本、异步 fetch、预取请求和 304；
3. 确认不再新增 `/favicon.ico` 明细后，在目标库执行 `sql/repair_site_analytics_non_page_paths_20260826.sql`；
4. 核对 path、visitor、daily 三层 PV 及逐日 UV 一致；保留三张 `_bak_20260826` 快照表直至观察期结束；
5. 发布 Electron 页面访问排行文案和信息提示。

本次纠偏不修改分析 API 的请求或响应结构，`topPages` 字段保持不变。旧客户端可以继续使用；服务端若回滚到旧分类器，应先关闭 `site.analytics.enabled`，避免重新写入资源请求。

## 用户 API

所有接口返回统一结构：

```json
{
  "code": 0,
  "message": "success",
  "data": {}
}
```

接口如下：

| 方法     | 路径                                                                       | 用途                                                           |
| -------- | -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET`    | `/api/sites?page=1&pageSize=10&keyword=&siteStatus=&accessMode=&siteKind=` | 当前用户站点列表；每个 `share_id` 只返回一条                   |
| `GET`    | `/api/sites/{shareId}`                                                     | 站点详情、可安全展示的部署信息、最近 10 条事件和所有者分享码   |
| `PATCH`  | `/api/sites/{shareId}`                                                     | 修改站点名称，请求体 `{ "title": "..." }`                      |
| `PUT`    | `/api/sites/{shareId}/access-mode`                                         | 修改访问方式，请求体 `{ "accessMode": "public\|code" }`        |
| `PATCH`  | `/api/sites/{shareId}/access-status`                                       | 停止或恢复，请求体 `{ "status": "disabled\|live" }`            |
| `DELETE` | `/api/sites/{shareId}`                                                     | 永久删除已停止站点；重复删除幂等成功                           |
| `GET`    | `/api/sites/{shareId}/analytics?from=yyyy-MM-dd&to=yyyy-MM-dd&limit=10`    | PV、跨日期去重 UV、每日趋势和页面访问排行                      |
| `GET`    | `/api/sites/deployment-quota?targetShareId=&page=1&pageSize=10&keyword=`   | 部署预检、套餐用量及可停止站点候选                             |
| `POST`   | `/api/sites/deployment-quota/reservations`                                 | 最终提交前申请短期名额；请求体包含 `requestKey` 和可选目标站点 |
| `DELETE` | `/api/sites/deployment-quota/reservations/{reservationId}`                 | 打包、上传或提交失败时主动释放名额                             |

服务端只从 JWT 解析 `userId`，不接受客户端传入用户 ID。列表默认和客户端固定页大小均为 10；服务端允许范围为 1～100。

## 状态与操作约束

- `online`：分享和最新部署均在线。
- `deploying`：排队、构建、部署或健康检查中。
- `access_stopped`：用户停止的静态站点，可直接恢复。
- `redeploy_required`：Node 云资源已释放，只能重新部署。
- `blocked`：管理员、审核或系统数量策略停止，用户不能直接恢复。
- `failed`：构建/部署失败或底层状态不一致。

停止 Node 服务会关闭访问并释放云资源；恢复时若没有在线部署返回 `SITE_REDEPLOY_REQUIRED`。访问方式在客户端先形成草稿，只有用户点击“提交变更”后才调用 PUT 接口。

永久删除只对已停止站点开放。客户端要求输入完整站点名称确认；服务端再次校验状态和所有权。Node 云资源或持久化服务数据尚未清理完成时返回 `SITE_DELETE_REQUIRES_STOPPED` 或底层清理错误，不创建删除墓碑。成功后站点立即从用户列表隐藏，清除访问凭证、页面文件和访问分析，NOS 文件异步删除；保留不可恢复且不可复用的 `share_id` 墓碑及最小内部部署审计记录。

列表查询的 `siteStatus` 额外支持聚合筛选值 `unavailable`，匹配 `access_stopped`、`redeploy_required`、`blocked` 和 `failed`。该值只用于查询，不会出现在单个站点的 `siteStatus` 响应中。

## 订阅站点配额

- 标准、进阶、专业、卓越套餐最多同时在线 5、15、40、100 个站点。
- 数量来自服务端环境配置；测试环境可设置更低值，调整后需重启当前服务实例生效，不修改套餐数据库记录。
- Node 与静态站点共享额度，按稳定 `share_id` 去重；同一在线站点重新部署不增加占用。
- 新站点、已停止站点重新部署和静态站点恢复需要新名额。套餐降级超额时保留已有站点，只拦截新增名额。
- 服务端不再存在单用户 3 个火山云函数的独立限制，也不会因超额自动停止旧服务。
- 普通 HTML/图片/文档 Artifact 分享继续使用原分享额度，但站点来源已从其计数和自动停止候选中排除。
- 新客户端提交 Node/静态 multipart 部署时增加 `quotaReservationId`。服务端仍对未传该字段的灰度期旧客户端执行原子最终校验。
- 客户端达到上限时由用户选择已有在线站点，经二次确认停止；停止成功后重新预检并返回原部署配置，不自动提交。

## 分析口径

- 只统计站点 Host 上确认为顶层文档导航的 `GET`：真实响应为成功 HTML，或浏览器缓存刷新返回 `304 Not Modified`。
- `Sec-Fetch-Dest` 存在时仅接受 `document`；缺失时依次使用 `Sec-Fetch-Mode: navigate + Accept: text/html` 和旧浏览器的 `Accept: text/html` 兼容规则。
- 不统计 `image`、`script`、`style`、`font`、`empty`、`iframe`、prefetch/prerender、管理员预览、分享码页面、`/_lobster_share/*`、健康检查和机器人；资源请求即使错误返回 `200 text/html` 也不计数。
- `/favicon.ico` 无条件排除。静态文件缺失时，只有文档导航允许回退入口 HTML；缺失的 favicon、图片、脚本等资源返回 404。
- PV 是 HTML 页面浏览次数，包括命中条件缓存的顶层文档刷新；资源和接口的 `304` 不计数。
- 日趋势 UV 为当日访客数；汇总 UV 使用所选日期范围内 `visitor_hash` 再去重，不能累加每日 UV。
- Cookie 为 `lobster_site_vid`，属性为 `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`。
- 数据库只保存访客 HMAC、path 和 path SHA-256，不保存原始 IP、query、fragment 或 Referer。
- 分析异步写入，失败不得影响站点响应。

Electron 页面标题使用「页面访问排行」，列名为「页面 / 浏览量 / 访客数」。首页直接显示 `/`；统计说明默认隐藏，通过标题旁信息图标访问。客户端不得自行过滤 `/favicon.ico` 来掩盖服务端或历史数据问题。

## 配置

```properties
site.management.enabled=true
site.analytics.enabled=true
site.analytics.time-zone=Asia/Shanghai
site.analytics.retention-days=180
site.analytics.max-query-days=90
site.analytics.cleanup-batch-size=1000
site.analytics.visitor-hash-secret=${SITE_ANALYTICS_VISITOR_HASH_SECRET}
# V62 执行并校验四档额度配置后再改为 true
site.quota.enabled=false
site.quota.plan-limits.standard=${SITE_QUOTA_PLAN_LIMIT_STANDARD:5}
site.quota.plan-limits.advanced=${SITE_QUOTA_PLAN_LIMIT_ADVANCED:15}
site.quota.plan-limits.professional=${SITE_QUOTA_PLAN_LIMIT_PROFESSIONAL:40}
site.quota.plan-limits.elite=${SITE_QUOTA_PLAN_LIMIT_ELITE:100}
site.quota.reservation-ttl-seconds=600
site.quota.cleanup-batch-size=500
site.quota.cleanup-delay-ms=60000
```

生产环境必须显式设置独立的 `SITE_ANALYTICS_VISITOR_HASH_SECRET`。密钥轮换会改变 UV 识别边界，需要记录生效日期。

## 业务错误码

| 标识                             |  数值 | 含义                                       |
| -------------------------------- | ----: | ------------------------------------------ |
| `SITE_NOT_FOUND`                 | 41601 | 站点不存在或不属于当前用户                 |
| `SITE_REDEPLOY_REQUIRED`         | 41604 | Node 服务需重新部署后恢复                  |
| `SITE_ANALYTICS_RANGE_INVALID`   | 41606 | 日期格式、顺序或最大 90 天范围不合法       |
| `SITE_ACTION_CONFLICT`           | 41607 | 当前部署状态不允许操作                     |
| `SITE_REOPEN_UNAVAILABLE`        | 41608 | 管理员、审核或系统策略停止，不能由用户恢复 |
| `SITE_ACTIVE_QUOTA_EXCEEDED`     | 41609 | 套餐在线站点额度已满                       |
| `SITE_QUOTA_CONFIG_INVALID`      | 41610 | 当前套餐缺少合法的环境额度配置             |
| `SITE_QUOTA_RESERVATION_INVALID` | 41611 | 预留不存在、过期、已消费或目标不一致       |
| `SITE_DELETE_REQUIRES_STOPPED`   | 41612 | 站点或 Node 云资源尚未完全停止             |

## 数据库验证

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN (
    'site_access_stats_daily',
    'site_visitor_access_stats_daily',
    'site_path_visitor_access_stats_daily',
    'site_quota_user_locks',
    'site_quota_reservations'
  );

```

迁移不回填旧的 IP 统计；上线前的产品分析数据按 0 展示。测试库没有 Flyway 历史表时，需要由发布负责人单独记录 SQL 执行结果。开启配额前还需核对服务启动日志中的四档配置，确认当前环境所有有效订阅的 `plans.name` 都能命中对应额度。

历史 favicon 修复脚本兼容 MySQL 5.7，只处理 `Asia/Shanghai` 已结束日期。脚本先创建 path、visitor、daily 三张持久快照，再在事务内删除精确 `/favicon.ico` 并从剩余 path 明细重建上层聚合；任何校验失败都会回滚原表修改。测试环境 2026-08-26 执行结果为：favicon 明细 0，三层总 PV 均为 108，daily/visitor 不一致数均为 0。
