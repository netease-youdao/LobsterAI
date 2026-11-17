# 广告位扩展：开屏弹窗、移动端广告位、按用户身份定向

日期：2026-11-11
前置文档：[`2026-11-10-client-banner-html.md`](2026-11-10-client-banner-html.md)（代码广告、随主题变化）

分支：
- Server、Admin：`feat/client-banner-html`
- 客户端：`feat/sidebar-banner-html`

## 1. Change Summary

- **新增广告位（`placement`）**

  | placement | 名称 | 端 | 支持的内容 |
  |---|---|---|---|
  | `desktop_launch_modal` | 桌面端开屏弹窗 | Electron | 图片 / 代码 |
  | `desktop_sidebar` | 桌面端左下角（已有） | Electron | 图片 / 代码 |
  | `mobile_launch_modal` | 移动端开屏弹窗 | iOS / Android | 仅图片 |
  | `mobile_home_banner` | 移动端首页横幅 | iOS / Android | 仅图片 |

- **按用户身份定向**：每条广告可以勾选投放人群。勾选多项时，用户命中任意一项就展示；不勾选表示全部用户。
- **开屏弹出频率**：开屏类广告位按每条广告单独配置弹出频率。
- **新增数据库列**：执行 `sql/V138__client_banner_targeting.sql`，必须在 V137 之后执行。

  | 列 | 类型 | 说明 |
  |---|---|---|
  | `audiences` | `VARCHAR(512) NULL` | 身份 key，逗号分隔；NULL 或空串表示全部用户 |
  | `display_frequency` | `VARCHAR(16) NOT NULL DEFAULT 'daily'` | 取值 `every_launch` / `daily` / `once` |

## 2. 投放人群（身份 key）

| key | 名称 | 判定口径 |
|---|---|---|
| `anonymous` | 未登录 | 请求中没有有效的登录态 |
| `member` | 有效订阅会员 | 月付、年付、后台赠送、Apple 订阅、0.01 体验，口径与 `EffectiveSubscriptionService.resolve` 一致 |
| `trial_in_progress` | 0.01 体验中 | `SubscriptionTrialService.activeTrial` |
| `member_expired` | 订阅已过期（曾订阅） | 当前不是会员，但有过订阅记录（Web 或 Apple） |
| `boost_holder` | 持有可用加油包 | 加油包剩余积分大于 0，**包含后台赠送的积分** |
| `never_paid` | 从未付费 | 没有个人付费订单（订阅、加油包或 Apple），退款订单不计入 |
| `paid` | 付费过 | 与 `never_paid` 相反 |
| `enterprise_member` | 企业/团队成员 | 已加入且状态为 active 的企业 |
| `employee` | 网易员工 | `users.user_type = 'internal'` |
| `new_user` | 新用户 | 注册 7 天内 |

几点说明：
- 审核账号不命中任何身份，只能看到不定向的广告。
- 身份结果按用户在 Redis 缓存 60 秒（`banner:aud:{userId}`），所以用户购买或订阅后，最多 60 秒才会生效。
- Admin 的选项来自 `GET /api/admin/app-banners/meta`，前端不写死。

## 3. Endpoint Details

### 客户端：`GET /api/client-banners/snapshot`

`/active` 和 `/active-list` 同样适用。

```
GET /api/client-banners/snapshot?placement=mobile_launch_modal&clientVersion=1.6.0
Authorization: Bearer <accessToken>      # 可选；带上才能按身份定向
```

- 路径仍然是 `permitAll`。
- 登录态的来源：带 JWT 时按 JWT 解析；不带 JWT 时尝试 Cookie（Portal）；都没有就按「未登录」处理。
- `placement` 不在白名单内时返回空列表，不报错。
- 不传 `contentTypes` 时只返回图片广告。移动端不要传 `html`。

banner 对象新增两个字段：

```json
{
  "id": 21,
  "placement": "mobile_launch_modal",
  "activityDescription": "双11充值福利",
  "linkUrl": "https://lobsterai.youdao.com/pricing",
  "imageUrl": "https://nos.../launch.png",
  "imageWidth": 800,
  "imageHeight": 1000,
  "contentType": "image",
  "audiences": "never_paid,new_user",
  "displayFrequency": "daily",
  "weight": 10,
  "onlineAt": "2026-11-11T00:00:00",
  "offlineAt": "2026-11-12T00:00:00",
  "updatedAt": "2026-11-11T08:00:00"
}
```

服务端已经按身份过滤过了，`audiences` 只用于展示和排查，客户端不需要再判断。

### Admin

- `GET /api/admin/app-banners/meta`：返回下列选项，供 Admin 页面使用：
  - `placements`：`[{value,label}]`
  - `audiences`：`[{value,label}]`
  - `displayFrequencies`：`[{value,label}]`
  - `launchPlacements`：开屏类广告位
  - `mobilePlacements`：移动端广告位
- `POST` / `PUT /api/admin/app-banners`：请求体新增 `audiences`（CSV，传空串表示全部用户）和 `displayFrequency`，两个字段都可选。保存时的校验：
  - `placement` 必须在白名单内。
  - `audiences` 里的 key 必须是已知身份。
  - 移动端广告位不能保存代码广告。
- 旧版 Admin 不传 `audiences` 时：
  - 更新：保留原值。
  - 新建：值为 NULL，即全部用户。

## 4. 客户端行为

### Electron（已在 `feat/sidebar-banner-html` 实现）

- 拉取广告时带登录态：主进程 `fetchClientBanner` 有 token 就带上；token 过期或会话无效时降级为不带 token 的请求，与活动接口的写法一致。
- 广告缓存按账号区分：缓存里记录 `audienceKey`。切换账号或退出登录时会重新拉取，不会看到上一个账号的定向广告。
- **开屏弹窗 `LaunchAdModal`**
  - 弹出条件：应用初始化完成、已同意隐私协议、新手引导和其他浮层都没有打开。首次安装的用户在完成引导之前不会弹。
  - 层级为 `z-[220]`，盖在引擎启动的加载层之上。gateway 由主进程在后台启动，不受影响。
  - 优先使用上次缓存的排期，所以启动后能立即弹出；启动 10 秒后还没确定要展示哪条，就跳过本次。
  - 每次启动最多弹一次。按权重选出一条符合频率条件的广告，点击后打开链接并关闭弹窗。
  - 打开期间，`StartupCreditCampaign` 和 `SubscriptionTrialCampaign` 会推迟到弹窗关闭后再弹。

### 移动端（App 团队实现）

- 启动时请求 `placement=mobile_launch_modal`，首页请求 `placement=mobile_home_banner`，并带上 `Authorization: Bearer`。
- 按 `weight` 做加权随机，再按 `displayFrequency` 在本地控制弹出频率：

  | 取值 | 含义 |
  |---|---|
  | `every_launch` | 每次冷启动都弹 |
  | `daily` | 每天第一次启动时弹 |
  | `once` | 同一版本被用户关闭或点击后不再弹，版本按 `id:updatedAt` 区分 |

- 图片按 `imageWidth` / `imageHeight` 的比例展示，点击后打开 `linkUrl`。

## 5. Notes & Caveats

- **发布顺序**：
  1. 执行 V137 和 V138。线上 `client_banners` 表约 5 行，可以直接执行。
  2. 发布 Server。
  3. 发布 Admin。
  4. 发布客户端。
- **向后兼容**：接口路径、字段、错误码都不变，新增的参数和字段都是可选的。
- **旧版客户端**：拉取广告时不带登录态，一律按「未登录」处理，因此看不到只投给登录身份（如会员）的广告。投给「未登录」或不定向的广告仍然可见。
- 「最低客户端版本」「投放时间」「投放开关」「权重」这些逻辑都没有变，身份过滤是在它们之后叠加的。
