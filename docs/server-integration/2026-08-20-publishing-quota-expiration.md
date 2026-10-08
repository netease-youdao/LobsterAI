# 分享与部署额度、过期联调说明

日期：2026-08-20（最近更新：2026-09-04）

状态：额度、过期能力、“普通用户升级订阅后恢复限时资源”、订阅恢复入口、恢复动作投影和公网暂停页均已完成客户端与服务端实现；Electron 手工 UI 与真实测试环境联调待执行。

## 涉及项目

- 客户端：`LobsterAI`（恢复按钮、订阅跳转和返回刷新）
- 服务端：`lobsterai-server`（恢复动作投影和公网暂停页）
- `lobsterai-portal`、`lobsterai-admin`：本期不改

## 数据库变更

V1.6 额度/过期基线上线前曾执行服务端迁移：

```text
lobsterai-server/sql/V77__publishing_quota_expiration.sql
```

迁移只给 `html_shares` 增加可空字段 `access_expires_at DATETIME NULL`，兼容 MySQL 5.7，不增加外键。`NULL` 表示按订阅/团队权益判断；非空表示固定公开访问截止时间。

订阅升级自动恢复不新增迁移或数据库表。它直接复用：

- `html_shares.access_expires_at IS NOT NULL` 识别仍处于普通用户固定时限语义的资源；
- 现有分享状态、关闭来源/原因判断是否允许自动恢复；
- 现有 `share_deployments` 状态对静态网站自动恢复和 Node 服务用户主动重新部署做并发抢占；自动检查不得启动 Node 服务。

恢复成功后清空 `access_expires_at`，资源自然退出候选集合；这同时构成幂等标记。不得为本场景增加升级批次表、恢复任务表或已处理标志列。

2026-09-04 的“订阅恢复”入口增量不增加任何 SQL、表、字段或索引，也不修改 V77。它只读取现有截止时间、分享关闭原因和 deployment 状态并返回动作投影，继续兼容 MySQL 5.7。

## 服务端配置

| 配置 | 默认值 | 说明 |
| --- | ---: | --- |
| `html-share.free-total-shares-per-user` | 10 | 普通用户累计文件分享数 |
| `site.quota.free-total-limit` | 1 | 普通用户累计网站数 |
| `html-share.free-access-ttl-seconds` | 7200 | 普通用户新资源固定有效期 |
| `html-share.entitlement-loss-grace-days` | 7 | 订阅/团队身份失效后的访问宽限期 |
| `html-share.enterprise-active-share-limit` | 100 | 每企业、每成员的活跃文件数 |
| `site.quota.enterprise-default-limit` | 5 | 每企业、每成员的活跃网站数 |
| `html-share.plan-active-limits.*` | 100/200/500/1000 | 各个人订阅套餐活跃文件数 |
| `site.quota.plan-limits.*` | 5/15/40/100 | 各个人订阅套餐活跃网站数 |

配置启动时要求为正数。客户端不硬编码额度或 2 小时，只展示服务端返回值。

## API 变化

### 普通用户公共体验策略

```http
GET /api/publishing/trial-policy
```

该接口免登录，只返回服务端当前普通用户产品策略：

```json
{
  "identityType": "free",
  "file": {
    "resourceKind": "file",
    "countMode": "total",
    "limit": 10,
    "accessTtlSeconds": 7200,
    "canReleaseByClosing": false
  },
  "site": {
    "resourceKind": "site",
    "countMode": "total",
    "limit": 1,
    "accessTtlSeconds": 7200,
    "canReleaseByClosing": false
  }
}
```

未登录分享/部署弹窗每次打开时读取对应资源的 `limit`，主操作“去登录”。接口读取失败时显示不带固定数字的降级文案，客户端不得回退到硬编码 10/1/2 小时。

### 文件分享额度预检

```http
GET /api/html-shares/quota
Authorization: Bearer <token>
```

响应 `data`：

```json
{
  "allowed": false,
  "identityType": "free",
  "resourceKind": "file",
  "countMode": "total",
  "planName": "free",
  "planDisplayName": "普通用户",
  "used": 10,
  "limit": 10,
  "remaining": 0,
  "canReleaseByClosing": false
}
```

预检只用于减少无效上传；创建接口仍在同一用户额度锁下做最终校验。

### 网站额度

既有网站 quota 响应新增：

```text
identityType: free | subscription | enterprise
resourceKind: site
countMode: total | active
canReleaseByClosing: boolean
```

普通用户按累计量统计，关闭、过期、删除均不释放；订阅和团队按活跃量统计。

### 额度错误

文件沿用 `HTML_SHARE_ACTIVE_LIMIT_EXCEEDED`，网站沿用 `SITE_ACTIVE_QUOTA_EXCEEDED`。错误响应 `data` 提供结构化额度快照：

```json
{
  "identityType": "subscription",
  "resourceKind": "file",
  "countMode": "active",
  "used": 100,
  "limit": 100,
  "canReleaseByClosing": true
}
```

Electron 主进程会保留该结构，渲染进程不得解析中文错误文案。普通用户命中总量额度后，弹窗使用响应中的 `limit`，主操作“去订阅”；订阅/团队命中活跃额度后，主操作“去处理”进入“我的文件 > 云端”。两种情况都不会自动关闭资源。

### 资源过期时间

- 分享创建、详情、状态与访问模式响应新增可选 `accessExpiresAt`。
- Library 云端列表的文件、网站条目新增可选 `accessExpiresAt`（Unix epoch 毫秒）。
- Library 云端列表条目新增只读有效状态投影：
  - `effectiveAvailable: boolean`；
  - `effectiveExpiresAt?: number`（Unix epoch 毫秒）；
  - `effectiveUnavailableReason?: share_not_live | site_not_online | free_access_expired | entitlement_grace_expired`。
- Library 云端列表顶层新增 `serverNow`（Unix epoch 毫秒）。
- Library 云端列表可选返回 `recoveryPending: boolean`；仅表示当前订阅账号仍有普通用户限时静态网站正在自动恢复或存在可立即自动处理的候选。已停止且等待用户重新部署的 Node 服务不计入 pending；旧客户端忽略该字段。
- 分享创建/状态/详情、站点列表/详情和 Library 云端条目新增可选 `subscriptionRecoveryMode: automatic | redeploy_required | none`。该字段只描述所有者下一步动作，不替代 `effective*` 的当前可访问性。
- 旧服务端不返回这些字段时，新客户端保持原展示且不猜测截止时间。

升级后的服务端在这些 owner 响应中固定返回三种小写 mode 之一；“可选”只用于滚动发布、旧服务端和回滚兼容。客户端不得把 `null` 或未知值当作可恢复。

示例：订阅身份失效超过宽限期、但尚未发生公开访问关闭时，数据库原始 `status` 仍可能为 `live`，列表会返回：

```json
{
  "status": "live",
  "accessExpiresAt": null,
  "effectiveAvailable": false,
  "effectiveExpiresAt": 1787211120000,
  "effectiveUnavailableReason": "entitlement_grace_expired"
}
```

客户端状态、可访问筛选、打开链接按钮及云端详情操作必须使用 `effective*` 投影和 `serverNow`，不能仅使用数据库原始 `status`。`effectiveExpiresAt` 允许页面停留期间在宽限期边界自动切换为不可访问，无需轮询服务端。

普通用户分享与部署详情弹窗根据服务端返回的 `accessExpiresAt/expiresAt` 显示“限时体验”和实际剩余时间。到期后客户端立即显示“链接已过期”并禁用权限更新和文件更新；恢复 CTA 实际可见时，任务内分享/部署弹窗的底部业务操作只保留“复制链接”和恢复 CTA，复制条件不满足时按钮保留但禁用。若账号后来升级为有效订阅，已停止 Node 服务应显示“需要重新部署”并重新启用用户主动重新部署入口，但不能由列表检查自动提交部署。

恢复动作计算由服务端集中 resolver 完成；`automatic` 必须与自动恢复候选保持一致，`redeploy_required` 则明确描述自动恢复排除的 Node 状态：

| 资源状态 | `subscriptionRecoveryMode` |
| --- | --- |
| 免费固定时限文件仍为 live，或只因 `free access expired` 关闭；未到期时表示潜在转换能力 | `automatic` |
| 分享与最新 deployment 均 live/active 的固定时限 Node/静态网站；或分享仍 live/仅因免费到期关闭、deployment 为 stopped/expired inactive 且来源完整的静态网站 | `automatic` |
| 分享仍为 live 或仅因免费到期关闭，且最新 deployment 为 stopped/expired inactive 的固定时限 Node 服务；无论截止时间是否已到 | `redeploy_required` |
| 用户、管理员、审核、活跃额度、未知原因关闭，或 `failed/deleted` | `none` |
| `accessExpiresAt = null` 的权益宽限期结束资源 | `none` |

`subscriptionRecoveryMode` 是恢复能力投影，不是“已经过期”标记。符合安全条件的固定时限资源在未到期时可以预先返回 `automatic/redeploy_required`；客户端只有在该 surface 对应的 `accessExpiresAt` 或 `expiresAt` 已到、资源当前不可访问、账号仍为个人普通账号时才显示购买入口。到期前的 stopped Node 沿用已有免费重新部署操作。这样倒计时在本地跨过到期边界时无需发网络请求即可出现 CTA。

时间基准不扩大本次服务端合同：Library 列表/详情继续使用列表级 `serverNow + monotonic elapsed`；任务分享/部署弹窗与 Sites owner 详情当前没有 `serverNow`，沿用既有 ISO 截止时间和客户端展示时钟，最终访问与写权限仍以服务端判断为准。

客户端不能直接使用 `disabledSource=system`、`effectiveUnavailableReason=share_not_live` 或通用“已过期”判断恢复入口。新客户端收到字段缺失、`null` 或未知枚举时按 `none` 处理；服务端不新增 `disabledSource`，也不改变 `effectiveUnavailableReason` 的既有语义。

客户端基于 `serverNow` 加单调时钟流逝量计算剩余时间，整个页面共用一个低频计时器；不轮询服务端、不逐行创建定时器。到期后立即在本地显示不可访问并禁用打开，最终权限仍由服务端校验。

## 服务端规则

### 普通登录用户

- 文件累计最多 10 个、网站累计最多 1 个（均可配置）。
- 创建时写入 `access_expires_at = created_at + TTL`；更新不延长。
- 截止时间到达后，公开访问和普通用户更新/重新开启失败。
- 过期仅在真实公开访问时条件关闭数据库状态；列表读取不写库。

### 订阅和团队用户

- 按活跃量统计，创建/重新开启时做并发安全的最终校验。
- 每次写操作和公开访问都只读查询当前订阅或团队身份，不把订阅有效期快照写进分享记录。
- 身份失效后，拥有者写操作立即拒绝；公开访问在失效时间起 7 天内仍可访问。
- 第 7 天后首次访问该具体链接时条件关闭该链接。只关闭本次访问的资源，不批量关闭该用户的其他资源。
- Library 云端列表对普通列表读取仍只计算 `effective*` 投影；唯一受控副作用是有效个人订阅用户请求无 cursor 的第一页时，可以触发下节所述的幂等升级恢复。筛选或搜索切换后产生的无 cursor 第一页同样会做快速候选检查，只有带 cursor 的续页不触发。
- 如果失效期间无人访问且用户已经恢复订阅/团队身份，旧链接继续有效。
- 一旦链接已因“订阅/团队权益失效宽限期结束”而关闭，恢复身份仍不会被本方案自动开启；该场景没有固定 `access_expires_at`，与普通用户限时体验升级严格分离。
- 网站公开访问被关闭后，异步停止对应运行资源；访问请求本身不等待清理任务。

### 普通用户升级订阅后的自动恢复（已实现）

#### 适用范围

仅处理个人普通用户阶段创建且 `access_expires_at IS NOT NULL` 的分享文件和网站。恢复服务执行前必须通过服务端订阅服务再次确认当前用户是有效个人订阅；不信任客户端传入的套餐或身份。

以下资源不自动恢复：

- 企业账号资源；
- 用户主动关闭、管理员关闭、审核拒绝、活跃额度关闭或未知关闭原因；
- `failed/deleted`；
- 订阅/团队权益失效宽限期结束后关闭的资源。

#### 触发顺序

两个入口复用同一 `PublishingSubscriptionRecoveryService` 幂等服务：

1. 订阅激活事务提交后异步触发；恢复失败不得回滚订阅或延长订阅接口耗时。
2. 有效个人订阅用户请求 `GET /api/library/cloud-items` 的无 cursor 第一页时自动兜底检查；这就是用户进入「我的文件 > 云端」、刷新或改变条件后重新请求第一页时的自动检查。带 cursor 的续页不检查。

当前单次事务最多锁定并处理 64 条候选。成功清空到期时间后不再命中，重复触发无需单独去重表。首期不增加定时扫描或后台补偿任务；若订阅事件处理失败，用户下一次请求云端第一页时自然重试。

#### 文件恢复

- 尚未到期且 `live`：清空 `access_expires_at`，其他字段不变。
- 到期但仍为 `live`：清空到期时间，随后按订阅权益正常访问。
- 仅因固定体验到期（`free access expired`）被系统关闭：用条件更新恢复 `live`、清理该到期原因并清空到期时间。
- URL、访问模式、分享码、内容版本、lineage、创建时间均保持不变。
- 条件更新必须同时校验非空到期标记、允许恢复的关闭原因和当前状态；并发的用户停止访问、管理员/审核动作优先。

#### 网站恢复

- Node 或静态运行资源仍在线：按文件规则转换分享记录即可，不重启运行资源。
- 已停止静态网站：静态内容仍由现有分享存储提供时，自动恢复服务使用现有 deployment 记录做条件更新，将 `stopped/expired` 恢复为 `live`，同时恢复分享状态并清空两侧到期时间；不创建新运行资源。
- 已停止 Node 服务：自动检查只投影为“不可访问 / 需要重新部署”，不清空到期时间、不进入自动队列、不调用部署平台；用户主动点击重新部署后才进入现有部署状态机。
- Node 用户主动重新部署成功后，服务端恢复分享状态并清空 `access_expires_at`；失败则保留不可访问、非空到期标记和可重试状态。
- 候选查询在 SQL 层排除已停止/已过期/需要重新部署的 `node_service_deployment`；它们不计入自动恢复执行数或 `recoveryPending`，到期标记只在用户重新部署成功后清除。
- 静态网站只有处于 `stopped/expired + active=0 + expires_at IS NOT NULL` 时才参与条件恢复；来源缺失、`failed/redeploy_required` 或其他状态继续保持不可访问，等待用户处理。
- 分享行先加写锁，deployment 使用带 owner、类型、状态和到期标记的条件更新；分享与 deployment 在同一事务提交，任一配对更新违反预期即整体回滚，不会出现一侧已恢复、另一侧仍过期。

#### 客户端刷新

- 客户端订阅/额度变更事件只清理当前发布账号的云端查询缓存并重拉，不乐观改状态。
- 第一页响应为 `recoveryPending=true` 时，客户端最多在 3 秒、10 秒和 30 秒各重拉一次；目标弹窗/页面离开只移除该目标的详情刷新订阅，不取消同 owner 已启动的 cloud 恢复批次；账号切换、退出登录、恢复完成或次数用尽才停止账号级协调器。
- 重拉按稳定资源 ID 原位合并，保留类型、状态、关键词、收藏筛选和滚动位置。
- 资源是否可访问始终使用服务端 `effective*` 和 `serverNow`，不能因客户端发现订阅成功就直接展示可访问。

### 订阅恢复入口（2026-09-04 增量）

#### 展示位置

| 界面 | 展示位置 | 行为 |
| --- | --- | --- |
| 任务内文件分享弹窗 | 底部操作区 | 恢复态只保留“复制链接”和“订阅恢复” |
| 任务内网站部署弹窗 | 底部操作区 | 恢复态只保留“复制链接”和恢复 CTA；`automatic` 显示“订阅恢复”，`redeploy_required` 显示“订阅后重新部署” |
| “我的文件 > 云端”列表 | 状态列右侧的无标题独立列 | 180px 状态列继续独立、居中展示状态和有效期；紧凑按钮单独占列并阻止行点击冒泡，最右“操作”列保持不变 |
| 云端文件详情 | 标题元信息行、不可访问状态之后 | 替换免费到期的泛化系统关闭说明 |
| 云端站点详情 | 站点标题元信息行 | 与文件详情复用同一模式和跳转 |

恢复 CTA 使用固定高对比反色方案：浅色主题为黑底白字，深色主题为白底黑字；不再跟随主题强调色。按钮保留 hover、active、focus-visible、键盘激活和中英文不换行。任务弹窗的“双按钮”约束只作用于 CTA 实际可见的恢复态；顶部关闭按钮、权限与期限说明保持不变，CTA 不可见后恢复原有创建、更新、部署、重试和权限操作。

按钮只在固定截止时间已到、资源当前不可访问、当前账号为个人普通账号且模式为 `automatic/redeploy_required` 时展示。有效个人订阅观察到 `automatic` 时不再展示购买按钮，而是启动权威刷新；企业账号、未到期资源、`none`、字段缺失和未知值都不展示。

恢复按钮不得回退到主题强调色；固定使用浅色黑底白字、深色白底黑字。所有新增标题、按钮和说明必须同时提供中英文 i18n。

#### 订阅页跳转

继续通过系统浏览器打开现有 Portal 套餐页：

```text
文件：#/pricing?keyfrom=html_share[&trace_id=...]
网站：#/pricing?keyfrom=site_deployment[&trace_id=...]
```

查询参数必须位于 hash 路由内部。不要跳 `/subscription`，该路由是账单分区；不要追加 `source=electron`，该参数会改变现有 Portal 登录流程。Portal 和 Admin 不需要接口或页面改动。Electron 客户端的七天 last-touch 订阅观察归因属于本次；Portal 当前不把 `keyfrom/trace_id` 传入订单，订单支付级精确归因如有需要另立需求。

#### 返回客户端后的刷新闭环

1. 点击恢复入口时按 owner 记录内存级等待意图和一次性强制聚焦检查标记，打开外部浏览器后保持当前资源上下文。
2. 窗口重新聚焦时，如果强制检查仍为 armed，则立即刷新订阅快照一次，不受普通 30 秒聚焦节流限制并消费本次标记；后续恢复普通节流，再次点击 CTA 才重新 armed。
3. 账号仍为 `free` 时保持现状；同一 owner 变为 `active` 后，使当前资源详情和云端无 cursor 第一页缓存失效并重拉。
4. 客户端冷启动或恢复登录时，如果账号已为 `active` 且打开的资源仍返回 `automatic`，也必须触发一次无 cursor 第一页兜底，不能只依赖进程内观测到 `free -> active`。
5. 第一页 `recoveryPending=true` 时复用 3/10/30 秒有界刷新；换账号、退出登录、恢复完成或次数耗尽后停止。
6. 无 cursor 第一页调用及有界重试由账号级共享恢复协调器负责，不依赖 Library 页面是否挂载。从任务弹窗返回时也能完成兜底；每轮 cloud 响应后刷新目标分享/站点详情，并使当前 owner 的 Library 查询失效。
7. 恢复成功按 surface 判断：文件 owner 响应要求 `status=live && accessExpiresAt=null`；Library 要求 `effectiveAvailable=true && accessExpiresAt=null`；站点/部署要求分享 live、站点或 deployment online/live 且对应的 `accessExpiresAt/expiresAt=null`。随后模式应收敛为 `none`；客户端不根据订阅状态乐观恢复。
8. 响应合并必须区分字段缺失与显式 `null`。文件/Library 的 `accessExpiresAt: null` 和任务部署/Sites 的 `expiresAt: null` 都要清除旧过期快照，不能用 `newValue ?? oldValue` 保留旧值；对应 TypeScript 字段应显式允许 `null`。

#### 客户端产品与订阅转化埋点

本节专指在 Electron 客户端产生、通过现有 `reportYdAnalyzer` 上传到分析服务端的产品事件，不是下文 `lobsterai-server` 进程运行日志，也不是分享访问量 owner analytics。内存等待意图和 `trace_id` 本身不等于已完成埋点。

| 客户端事件 | 触发条件 |
| --- | --- |
| `lobsterai_publishing_recovery_cta_exposure` | CTA 首次实际可见；列表行进入可视区、页面停留跨过到期边界时同样触发 |
| `lobsterai_publishing_recovery_cta_action` | 鼠标/键盘激活被接受后，在记录等待意图及 `openExternal()` 之前 |
| `lobsterai_publishing_subscription_observed` | 复用既有事件；同 owner 的 auth/quota 权威快照在有效 last-touch 内观察到有效订阅 |
| `lobsterai_publishing_recovery_result` | 订阅观察后，资源权威响应收敛或有界重试用尽 |

三个新增 recovery 事件使用独立 `PublishingRecoveryAnalyticsEventVersion=1` 和独立参数 builder，不直接复用会写入 v2 的旧 publishing builder。共同字段为 `attemptId/exposureId/interactionType/feature/resourceKind/operationType/source/entryPoint/surface/recoverySurface/pageViewId/hasExistingResource/identityType/subscriptionRecoveryMode`；固定 `interactionType=recovery_cta`、`operationType=subscription_recovery`、`hasExistingResource=true`、`identityType=free`。点击另带 `actionType=click`、`ctaId=primary`、`target=pricing`、`operationId` 和 `exposureToClickMs`。`recoverySurface` 是新维度，不覆盖旧 `surface`。

| `recoverySurface` | `source` | `entryPoint` |
| --- | --- | --- |
| `task_file_share_dialog` | 继承文件弹窗原 attempt | 继承原 attempt |
| `task_site_deployment_dialog` | 继承部署弹窗原 attempt | 继承原 attempt |
| `library_cloud_list` | `library_list` | 新增 `subscription_recovery_cta` |
| `library_file_detail` | `library_preview` | `library_settings` |
| `library_site_detail` | `library_preview` | `library_settings` |

任务弹窗只从原 attempt 派生 recovery context，不突变原对象；恢复 CTA 只报新 recovery 事件，不再双报旧 `PublishingDialogAction/DeploymentStatusAction`。同一可见周期的 `attemptId` 贯穿曝光、点击、订阅观察和恢复结果，并必须与套餐 URL 的 `trace_id` 相同；每次真实点击生成新 `operationId`。曝光以 owner、页面/弹窗生命周期、本地资源 key、surface 和 mode 在客户端去重；倒计时 rerender、刷新、轮询和虚拟列表重挂载不重复曝光。`exposureToClickMs` 从本次曝光创建时计时，不扣除中间离开可视区的时间。

点击复用现有七天 `rememberPublishingConversionAttribution`，last-touch 覆盖前一未过期触点。旧 input 的 `dialogType/dialogVisibleMs` 对 `interactionType=recovery_cta` 改为可选，内联 CTA 使用 `exposureToClickMs`。归因存储使用“本地 envelope + 显式上报 allowlist”：`ownerAccountKey/resourceKey` 可仅本地保存，禁止把 `...attribution` 整体展开到 `reportYdAnalyzer`。storage 升级版本，无 owner scope 的旧记录丢弃。

`reportPendingPublishingSubscriptionObserved` 改为接收当前权威 `ownerAccountKey + accountMode + subscriptionStatus`，`auth.ts` 的初始化/刷新调用点都传入完整快照；owner 不一致时清理且不上报。恢复 CTA 归因只接受同 personal owner 的 `subscriptionStatus=active`，既有其他发布 CTA 对 enterprise 的旧规则不变。换账号、登出、关闭 `usageAnalyticsEnabled`、7 天过期或 observed 成功上报后清理；普通网络/HTTP 失败时保留 attribution，后续 auth/quota 刷新重试可生成新 `eventId`，以不变的 `operationId/exposureId` 去重。网站恢复入口必须直接接入共用 attribution writer，不得靠双报 generic dialog action 补偿。

`subscription_observed` 只表示同 personal owner 已观察到 `active` 且事件上传成功，不得命名为 `payment_success`，不代表资源已恢复。`recovery_result.outcome` 只允许 `restored/redeploy_ready/retry_exhausted/resource_unavailable`，并携带最新点击 `operationId` 以及从该点击到终态的 `durationMs`。`automatic` 权威可访问且期限为 `null` 才记 `restored`；`redeploy_required` 订阅后记 `redeploy_ready`，真实重部署继续使用既有 deployment result；同 owner 已为 active 但有界重试不收敛才记 `retry_exhausted`。协调器另存 in-flight analytics context；observed 成功只清 last-touch，不清结果关联。多次点击只保留最新 `operationId` 的终态，取消购买、仍为 free 或浏览器账号不一致不记转化失败。

埋点失败不阻断打开套餐页。payload 必须经显式 allowlist 生成，不得包含 `ownerAccountKey/resourceKey`、`shareId/siteId/deploymentId`、文件名、本地路径、URL、分享码、任务标题、搜索词或资源内容。

#### 公网暂停页

公网访问者不是资源所有者，不展示购买按钮：

- `automatic`：文件和静态网站显示“该分享已暂停 / 分享者订阅后，该分享将自动恢复”，网站使用对应网站文案；
- Node 免费到期或 `redeploy_required`：统一保守显示“分享者订阅并重新部署后可恢复访问”，避免公开访问排队异步停止 deployment 时错误承诺自动恢复；
- `none`：保留现有人工关闭、管理员关闭、安全审核、额度关闭或通用不可访问文案。

本增量不改变公网响应的既有 HTTP 状态码、缓存头、访问码、管理员预览或安全判断顺序。

#### 实现边界

- 服务端建议新增集中 `SubscriptionRecoveryModeResolver`，由 `HtmlShareCreateResponse`、`HtmlShareStatusResponse`、`ShareDeploymentResponse`、`SiteListItem`（详情继承）和 `LibraryCloudItem` 统一消费；Library/Site Mapper 一次性返回计算所需的关闭原因、固定截止时间和最新 deployment `status/active`，禁止逐项补查。
- 客户端在现有 `src/shared/publishing/constants.ts` 增加 mode 常量和 fail-closed normalizer；`htmlShareClient`、`shareDeploymentClient`、`libraryCloudClient` 与 Site 类型只做白名单解析/透传，Main/Preload 不新增恢复写 IPC。
- 共享恢复按钮与展示策略供 `ArtifactFileShareDialog`、`ArtifactPanel`、`LibrarySharedFilesView` 和 `SitesView` 使用；账号级恢复协调器放 Renderer service，不放在任一页面组件生命周期内。
- 套餐 URL 复用 `src/renderer/services/endpoints.ts` 的 `getPortalPricingUrl`/`PortalPricingKeyfrom`；IDE 当前打开的 `src/main/libs/endpoints.ts` 不属于本需求，不修改。
- 客户端埋点在 `src/shared/analytics/constants.ts`、`src/renderer/components/artifacts/publishingAnalytics.ts` 和 `src/renderer/services/publishingConversionAttribution.ts` 扩展，统一恢复 CTA helper 同时支持弹窗和内联入口，不新增 `lobsterai-server` 埋点接口。

#### 服务端运行日志与监控指标（非客户端转化埋点）

服务端日志统一使用 `[PublishingRecovery]`，记录触发来源、用户 ID、候选数、文件恢复数、在线网站转换数、静态网站恢复数、跳过数、是否仍有待处理候选和耗时；不得记录文件名、URL、分享码或本地路径。已停止 Node 服务在候选 SQL 中被排除，不计为失败或积压。

## 上线顺序

### V1.6 额度、过期与自动恢复基线（历史，已完成）

1. 备份并执行 V77 数据库迁移。
2. 发布包含新配置、额度校验和访问守卫的服务端。
3. 发布服务端订阅提交后事件、恢复服务和 Library 第一页兜底；确认自动检查始终不会启动已停止 Node 服务。
4. 验证额度接口、Library `effective*` 与可选 `recoveryPending`。

历史基线回滚时可以保留可空字段。V1.7 不重复执行或修改 V77。

### V1.7 订阅恢复入口（本次）

1. 发布集中恢复 mode resolver、可选 `subscriptionRecoveryMode`、必要投影列和公网暂停页分支的服务端；确认旧客户端忽略新增字段，既有 API 路径、请求参数、错误码和 HTTP 行为不变。
2. 发布支持恢复入口、首次回焦强制刷新、两种期限字段显式 null 清理、冷启动兜底和账号级 3/10/30 秒有界刷新的客户端。
3. 客户端分析平台观察分 surface/mode 的 CTA 曝光、点击、`subscription_observed` 和恢复结果；服务端单独观察模式分布、自动恢复、pending、耗时及 Node 重新部署结果，两类数据达标后全量。

V1.7 没有数据库步骤。服务端先行、客户端后发；服务端回滚后新客户端把字段缺失视为 `none`，客户端回滚后旧客户端忽略新增 JSON 字段。公网文案可以独立回滚，不影响恢复数据。

## 验证重点

- 普通用户第 10/1 个资源可创建，第 11/2 个并发创建也必须失败。
- 关闭、过期、删除普通资源后累计额度不恢复。
- 普通资源更新不改变原截止时间，边界 `now == accessExpiresAt` 即失效。
- 订阅退款/取消、自然到期、企业停用、成员移除的失效时间分别正确。
- 身份失效超过 7 天后只在访问目标链接时关闭该链接；恢复身份后不自动恢复这类“权益宽限期结束”资源。
- 身份失效超过 7 天但尚未触发关闭时，Library 原始状态可以仍为 `live`，但 `effectiveAvailable=false`，客户端必须显示不可访问；恢复身份后刷新会恢复有效投影。
- 客户端云端列表的文件和网站共用服务端时间基准，过期后无需网络轮询即可更新状态。
- 普通用户限时资源升级订阅后，未到期和已因固定时限到期的文件均自动转换；原 URL、权限模式和分享码不变。
- 用户/管理员/审核/额度关闭不会被恢复；订阅激活、云端第一页和补偿任务并发触发时结果幂等。
- 已停止静态网站只有自动恢复成功后可访问；失败或来源缺失保持不可访问。已停止 Node 服务在自动检查后仍不可访问，且没有部署请求；用户主动重新部署成功后才恢复。
- 订阅激活成功不受恢复失败影响；用户首次进入云端页会再次自动检查。
- 恢复方案没有新增表或 DDL，候选 SQL 与条件更新通过 MySQL 5.7 验证。
- 个人普通账号只有在 `subscriptionRecoveryMode=automatic/redeploy_required` 时显示对应入口；用户/管理员/审核/额度关闭、权益宽限期结束和未知值均不显示。
- 文件和网站分别跳转 `keyfrom=html_share/site_deployment`，可选 `trace_id` 正确编码；不跳账单页、不添加 `source=electron`。
- 列表按钮位于状态列右侧收紧后的 120px 独立无标题列并在列内左对齐，同时向状态方向利用留白紧邻展示；不改变 180px 状态列内状态/有效期的原有居中排版且不触发行点击。所有恢复 CTA 在浅色主题为黑底白字、深色主题为白底黑字，并具备可见 hover/active/focus 状态。
- 任务内分享与部署弹窗仅在恢复 CTA 实际可见时把底部操作裁剪为“复制链接 + 恢复 CTA”；复制不可用时仍保留禁用按钮，CTA 消失后原动作集完整恢复。
- 点击后未购买、取消购买或浏览器账号不一致时不改变资源；同一 owner 订阅生效、客户端冷启动或重新聚焦后均可通过权威重拉收敛。
- 文件/Library 显式返回 `accessExpiresAt=null`、部署/Sites 返回 `expiresAt=null` 后，各自清除过期标记并按 surface 的权威状态收敛；目标页面离开不终止同 owner 的账号级恢复批次，`recoveryPending` 重试不会无限运行。
- 公网文件/网站准确区分自动恢复、重新部署和不可恢复文案，同时保持既有 HTTP、缓存和安全行为。
- 新客户端连接旧服务端、收到 `null` 或未知恢复枚举时保持稳定并隐藏入口；旧客户端连接新服务端行为不变。
- 五个 surface 的曝光/点击字段、mode 和 `attemptId=trace_id` 正确；网站弹窗能写入 last-touch 且不双报。
- 倒计时跨界会生成一次曝光，rerender、轮询和虚拟列表重挂载不重复；重新打开/新 page view 可以生成新曝光。
- 同 owner 七天内观察到有效订阅只成功上报一次 `subscription_observed`；换账号、过期、关闭使用分析不误记，上报失败会保留重试。
- 客户端埋点 payload 不含 owner/resource ID、文件名、路径、URL、分享码、任务标题、搜索词或资源内容，上报失败不阻断订阅页跳转。

## 实施验证（2026-09-04）

- 客户端目标 ESLint、目标 Vitest（本轮 UI 收口复跑 8 个文件、110 项）、`npm run build` 和 `npm run compile:electron` 已通过。
- 服务端 `compileJava`、`compileTestJava`、Mapper XML 语法检查及差异格式检查已通过。
- 按约定未运行依赖 Redis/外部发布服务的服务端测试套件；未连接或修改测试数据库。
- Electron 手工 UI、套餐页真实返回链路及测试环境端到端联调尚未执行。
