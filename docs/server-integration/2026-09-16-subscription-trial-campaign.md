# 0.01 元标准版体验活动（2026-09-16）

## 变更摘要与分支

Server、Portal、Electron 均从各自 `feat/low-credit-purchase-offer` 创建 `feat/one-cent-subscription-trial`，无 upstream；本次不提交、不推送、不合并，也不修改线上数据库和 Overmind。

这是独立活动，不接入低余额优惠的资格、折扣、订单替换或核销。旧 0.01 活动保持原配置；不得重新开启旧活动。本次不修改 Admin，左下角广告五类人群另行开发。

## 规则与状态

- 当前个人身份且无有效订阅可购买，历史订阅到期可参加。团队身份隐藏并拒绝下单；切回个人后刷新判断。匿名可见，购买须登录。
- 以 `(user_id, campaign_code)` 唯一参与记录限制每账号每活动一次成功购买。待支付不消耗资格；成功后取消、退款、自然到期均不恢复资格。
- 首笔 ¥0.01，只发 1000 独立活动积分及 Standard 功能权限；当期套餐、常规赠送和充值活动赠送积分均为 0。原免费、邀请、活动和加油包积分保留；复用全局按到期时间优先扣减。
- 全部时间为北京时间，支付当天不计。9 月 16 日任何时刻支付：9 月 21 日 08:40 预通知，9 月 23 日 10:00 首次 ¥49 扣款，体验权益与未用活动积分至 9 月 23 日 23:59:59。
- 复用现有 `SubscriptionPreNotifyJob`（D-2 08:40）和 `SubscriptionRenewalJob`（10:00）。Luna 调度、服务 JVM 和数据库业务时区需保持现有北京时间设置。首次扣款日期存入协议，与循环倒计时无关。
- 续费成功立即进入标准版正常周期，按现有普通订阅计算 31 天日末到期、按月自动扣款；解除升级限制。剩余体验积分保留原到期时间。续费失败沿用已有重试规则，体验权益和活动积分仍按原时间到期。
- 取消自动续订保留体验至到期。退款沿用 Admin 原有退款与“清理权益”选项，清理体验订单时只标记关联积分为 refunded；只有仍属于该订单的体验订阅才取消，不清除其他积分或已经续费转正的套餐。
- 体验期间禁止升级和绕过升级接口直接新购套餐；服务端创建订单及支付结算均检查。加油包独立运行。

## 数据与幂等

先执行 Server `sql/V91__subscription_trial_campaign.sql`，无外键、无历史数据改写。

新增 `subscription_trial_participations`（pending/active/converted/refunded，成功时间永久保留）和 `payment_orders.subscription_trial_id`。

1000 积分复用 `invitation_user_reward_credits`，类型 campaign，来源 `subscription_trial:<participationId>`，关联 `reward_credit_id`；不混入 monthly_credits。

创建体验订单按用户行锁串行，复用有效待支付订单。过期待支付订单在现有 10 秒恢复任务确认渠道关闭前不发新链接，客户端提示稍后重试。支付验签、金额核验和查单凭证校验沿用现有实现；回调和补偿共用订单锁，参与记录锁与事务保护发放。不同订单重复支付或支付时资格变化转为 `payment_review` 并保留渠道凭证供现有对账处理，不覆盖已有订阅、不重复发放。

## Overmind 配置

独立 key：`subscription-trial-campaign`。默认关闭，示例见 Server `docs/config/subscription-trial-campaign.example.json`：

```json
{
  "enabled": false,
  "campaignCode": "standard_trial_2026_09",
  "planId": 0,
  "startAt": null,
  "endAt": null,
  "countdownCycleEnabled": false,
  "countdownCycleMinutes": 2880
}
```

上线前填入实际 `name=standard`、上架、月价 49 元的套餐 ID 和活动起止时间。示例 `planId=0` 仅为占位，不能启用。时间支持 `2026-09-16T00:00:00` 或空格格式，区间 `[startAt,endAt)`。缺失配置默认关闭，非法更新保留最后合法配置。

循环开启时，从固定 startAt 起按分钟数分轮，最后一轮截断到真实 endAt；关闭循环直接倒计时到 endAt。只重算展示倒计时，不更新 campaignCode，不重置购买记录、体验截止或当日弹窗记录。修改 campaignCode 即新活动，不能用来循环同一活动。关闭配置只停止新下单和展示，已支付权益、已建立续费协议不受影响。

## 接口与鉴权

统一响应 `{ "code": 0, "message": "success", "data": ... }`。

Portal 支持 Cookie/Session（`credentials: include`）及现有 JWT Bearer；Electron 在主进程使用现有 `fetchWithAuth` 自动刷新 JWT，匿名查询使用 `net.fetch`。身份以服务端认证上下文为准，不接收 userId/enterpriseId、金额、积分、planId 或时间参数。

### GET /api/subscription-trial

允许匿名，`Cache-Control: no-store`。返回：

```json
{
  "campaignCode": "standard_trial_2026_09",
  "active": true,
  "visible": true,
  "eligible": true,
  "reason": "eligible",
  "planId": 2,
  "price": 0.01,
  "credits": 1000,
  "renewalPrice": 49.00,
  "trialDays": 7,
  "serverTimeEpochMs": 1789531200000,
  "startAtEpochMs": 1789488000000,
  "endAtEpochMs": 1790784000000,
  "expectedTrialEndsAtEpochMs": 1790179199000,
  "firstRenewalDate": "2026-09-23",
  "countdownCycleEnabled": false,
  "countdownCycleMinutes": 2880,
  "cycleEndAtEpochMs": 1790784000000,
  "trial": { "active": false, "endsAtEpochMs": null, "campaignCode": null }
}
```

示例为字段形状，planId 应使用实际配置值。reason 为 inactive/enterprise/already_purchased/subscribed/login_required/eligible；匿名 visible 可为 true，eligible 始终 false。预计截止与首次续费日期基于查询当天，最终以实际支付成功日期为准。

### POST /api/subscription-trial/orders

必须登录、个人身份并明确同意协议：

```json
{ "campaignCode": "standard_trial_2026_09", "agreementAccepted": true }
```

返回现有订阅创建订单结构（orderNo、amount、qrCodeUrl/wechatQrUrl、过期时间等），增加：

```json
{
  "subscriptionTrial": true,
  "campaignCode": "standard_trial_2026_09",
  "amount": 0.01,
  "originalAmount": 0.01,
  "baseCredits": 1000,
  "bonusCredits": 0,
  "totalCredits": 1000,
  "trialEndsAtEpochMs": 1790179199000,
  "firstRenewalDate": "2026-09-23",
  "renewalPrice": 49.00
}
```

复用微信 H5 签约页和二维码、`GET /api/subscription/order-status/{orderNo}` 轮询；不要调用低余额优惠报价或替换接口。支付金额与资格由服务端确定。

### GET /api/subscription（新增字段）

```json
{ "trial": { "active": true, "endsAtEpochMs": 1790179199000, "campaignCode": "standard_trial_2026_09" }, "canUpgrade": false }
```

canUpgrade=false 时升级按钮置灰，说明“体验期内暂不支持套餐升级”。续费成功或体验到期后刷新恢复。即使活动配置关闭，已生效的体验标识与限制仍有效。

### 客户端本地弹窗状态

服务端仅提供活动状态和购买资格，不提供弹窗领取接口，不记录曝光日期。每日一次针对同一客户端，匿名、登录和切换账号共用同一份本地记录，不做跨设备同步。

复用广告位的 `localStore`（Electron 本地存储），key 为 `subscription_trial.client_popup.v1:<testMode>:<campaignCode>`：

```json
{ "nextShowAt": 1789574400000, "expiresAt": 1790784000000 }
```

真正展示后保存 nextShowAt（北京时间次日零点）和 expiresAt（活动截止时间）。当天手动关闭、购买跳转、登录退出、账号切换、客户端重启均不重置次数。不同客户端独立计算。活动循环只更新倒计时，不影响本地频控。

本地根据服务端校准时间启动截止定时器；活动到期自动隐藏，不等待下一次接口轮询。客户端从休眠、后台恢复时立即校验本地截止时间；订阅状态变为 active 时立即隐藏。后续状态查询只用于资格及配置同步，不写任何服务端弹窗记录。

### 错误码

- 42400：当前不可参与标准版体验活动，刷新活动资格。
- 42401：体验期内暂不支持套餐升级，刷新订阅状态并禁用升级。
- 40100：登录失效，走原登录流程。
- 参数未同意协议使用现有 INVALID_PARAMETER。

## Portal 实现事项

PricingView 挂载独立活动横幅，保留既有低余额优惠、充值活动；个人身份显示，团队页和团队身份隐藏。横幅使用服务端时间校准的循环倒计时，每分钟及页面聚焦时同步活动状态。

匿名点击后保留 `trialCampaign`、tab 与现有 source 查询参数，登录回到定价页继续协议确认。协议和支付页明确首笔、1000 积分、首次续费日及 49 元/月、取消方式与升级限制。确认后通过独立 createTrialOrder 下单，状态变更或身份切换关闭旧弹窗。PlanCard 和购买处理函数共同拦截升级。

## Electron 实现事项

新增独立 `subscriptionTrial` IPC，仅允许主窗口主 frame 调用，API 基址复用主进程端点配置。响应失败保持不展示，不把认证失败降为匿名活动。

新装用户完成引导和登录后展示；完成引导但未登录的状态持久保存，下次启动仍等待首次登录。未登录与已登录非订阅用户均由本客户端的本地记录按北京时间每日频控；活动到期通过本地定时器自动消失。

活动弹窗避让引导、引擎启动、更新、权限及已有公共 Modal/对话框；其他弹窗关闭后再显示。身份变更时丢弃过期异步响应，团队隐藏，切回个人重新拉取。购买通过系统浏览器进入 `#/pricing?tab=subscription&banner=penny&trialCampaign=<code>&trialCheckout=1`，定位 0.01 广告并自动打开订阅服务协议；网页未登录时先登录，返回后自动打开协议，同意后进入支付。

## 验证与发布

Java 定向构建覆盖配置合法性、匿名/团队/订阅资格、购买成功后退款不恢复资格、循环不重置、重复回调发放、重复订单、正常套餐绕过拦截、取消续费后升级限制、关联退款、零月度积分、首次扣款日期及已有积分到期排序/续费测试。

Portal 和 Electron 按 package.json 执行 npm run lint、npm run build。遵照要求未启动开发服务、浏览器、视觉或交互测试。真实微信签约、预通知、扣款、回调联调须在配置测试环境后验收，编译和单元检查不代表已经完成渠道联调。

发布顺序：数据库 V91 → Server → Portal → Electron → 填妥配置并开启活动。活动关闭回滚不撤回已购权益，不关闭已有协议，不删除参与记录；不要删除新增表或列再运行新代码。


## 广告轮播与客户端入口（2026-09-16）

- Portal 广告模板、样式和文案来自 `dingjiaye-penny-subscription-banner` 的 `82f0ccb`，仅复制广告相关实现，不合并该分支的套餐卡片或低余额优惠修改。
- 每 3 秒轮播，鼠标悬停或键盘焦点在广告内时暂停，离开后重新计时。正式环境的 0.01 广告仍按服务端活动窗口、用户资格和个人身份展示，循环倒计时不会重置购买资格。团队积分包广告属于后续活动，当前开发与正式环境的主页轮播均不展示，保留模板和样式供后续启用。
- 客户端弹窗进入 `#/pricing?tab=subscription&banner=penny&trialCampaign=<code>&trialCheckout=1`；`banner=penny` 选中广告，`trialCheckout=1` 自动进入协议确认（未登录先登录），仅在用户点击「同意并继续」后下单。单独的 `banner=penny` 仍只定位广告。旧的 `trialCampaign` 定位参数继续兼容。活动接口较晚返回时，资格确认后切至 0.01 广告；不可参与的账号不强行显示。
- 左下角 0.01 广告建议将链接配置为 `#/pricing?tab=subscription&banner=penny`（前面加当前环境 Portal 地址）。客户端也会为带 `trialCampaign` 参数或活动描述含 `0.01` 的 Portal 定价链接补齐目标参数，并保留原有来源参数。其他广告链接不变；本次未修改线上广告配置。
- 点击「立即解锁」仍走当前协议确认和支付流程；未登录时返回地址附加 `trialCheckout=1`，登录返回后继续确认。
- 本地开发直接访问 `https://local.youdao.com:5180/` 即显示充值与 0.01 两张广告，无需 `previewBanner` 参数；`/?banner=penny` 可验证默认选中 0.01。示例展示仅在开发环境生效，其倒计时不会用于下单或资格判断。正式构建仍使用活动接口控制 0.01 广告的资格与窗口。


## 客户端弹窗验收与埋点补齐（2026-09-16）

- 弹窗触发：活动状态有效、个人非订阅身份；已有匿名用户可展示，新用户完成引导后仍须等待首次登录。引擎启动、引导、设置、更新和其他对话框关闭后再展示。
- 每日频控：按服务端时间校准北京时间；同一客户端共用本地记录，登录、退出、切换账号均不重置次数，不向服务端领取或上报展示资格。遇到其他弹窗时等待，真正渲染后才保存次日零点与活动截止时间。关闭后当天不再展示，活动到期或订阅状态变为 active 时立即隐藏。
- 点击埋点：`lobsterai_subscription_trial_unlock_click`，每次有效「立即解锁」点击上报一次，在异步资格复核和浏览器跳转之前记录。字段：`campaignCode`、`source=trial_popup`、`isLoggedIn=true/false`；公共字段沿用日志组件，包括点击时的 `is_logged_in`、环境、版本及设备标识。遵循现有 `usageAnalyticsEnabled` 开关，账号身份不在业务事件中重复传输。
- 故障诊断：客户端日志 `[SubscriptionTrial] Popup state:` 区分 `status_unavailable`、`claim_unavailable`、`inactive`、`subscribed`、`enterprise`、`waiting_for_first_login`、`waiting_for_other_dialog`、`shown_today`、`account_shown_today` 与 `shown`。主进程在 API 失败时记录服务器地址、认证状态、HTTP 状态和业务错误码，相同错误去重；不记录 Token、账号信息或响应正文。
- 本次现场检查：运行中的开发客户端使用测试模式，未设置 `LOBSTER_SERVER_BASE_URL`，因此请求测试后端 `https://lobsterai-server.inner.youdao.com`；其匿名 `GET /api/subscription-trial` 返回 HTTP 401 / code 40100，客户端日志为 `status_unavailable`。这是实际弹窗联调的阻塞，不能以本地 Portal 广告展示或客户端构建成功代替验收。
- 接入前置条件仍为：部署 V91 和本分支 Server，确保活动状态 GET 支持匿名访问，并配置有效的标准版 planId、活动起止时间及 enabled。配置示例默认关闭，本次没有发布服务或修改线上配置。主进程 IPC 诊断修改需重启开发客户端后生效。
