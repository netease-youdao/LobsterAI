# 广告位：桌面端开屏弹窗宽度可配置

日期：2026-11-12
前置文档：[`2026-11-11-client-banner-placements-targeting.md`](2026-11-11-client-banner-placements-targeting.md)

分支：
- Server、Admin：`feat/client-banner-html`
- 客户端：`feat/sidebar-banner-html`

## 1. Change Summary

- 运营在 Admin 配置「桌面端开屏弹窗」广告时，可以设置弹窗宽度。例如双栏宽版广告可以设为 760px。
- 只配置宽度。高度仍由内容决定：代码广告按 HTML 高度，图片广告按 `imageWidth/imageHeight` 比例。
- 新增数据库列：执行 `sql/V140__client_banner_modal_width.sql`，在 V138 之后执行。

  | 列 | 类型 | 说明 |
  |---|---|---|
  | `modal_width` | `INT NULL` | 桌面端开屏弹窗宽度（px）；NULL 表示客户端默认 400 |

## 2. Endpoint Details

### 客户端：`GET /api/client-banners/snapshot`（以及 `/active`、`/active-list`）

路径、参数、认证都不变。每条广告新增一个可选字段：

```json
{
  "id": 18,
  "placement": "desktop_launch_modal",
  "contentType": "html",
  "htmlContent": "<style>…</style><div class=\"wrap\">…</div>",
  "displayFrequency": "every_launch",
  "modalWidth": 760
}
```

- `modalWidth`：整数，单位 px，范围 320–960。只有 `desktop_launch_modal` 可能有值，其他广告位始终是 `null`。
- 值为 `null` 或缺失时，按默认 400px 展示。

### Admin：`GET /api/admin/app-banners/meta`

新增两个字段：

```json
{
  "modalWidthPlacements": ["desktop_launch_modal"],
  "modalWidth": { "default": 400, "min": 320, "max": 960 }
}
```

### Admin：`POST /api/admin/app-banners`、`PUT /api/admin/app-banners/{id}`

请求体新增可选字段 `modalWidth`：

- 广告位是 `desktop_launch_modal` 时，取值必须在 320–960 之间，否则返回「弹窗宽度必须在 320-960px 之间」。
- 其他广告位会忽略这个字段。
- 不传或传 `null`：新建时存 NULL，客户端按 400 展示；更新时保留原值。旧版 Admin 保存时不会清掉已配置的宽度。

## 3. Frontend Action Items

**Electron（已在 `feat/sidebar-banner-html` 实现）**
- `LaunchAdModal` 按 `resolveLaunchAdWidth(banner)` 设置弹窗宽度，仍然限制为 `max-w-[90vw]`。
- 缺失、非数字或超出 320–960 时回退到 400。

**Admin（已在 `feat/client-banner-html` 实现）**
- 桌面端开屏弹窗的编辑表单新增「弹窗宽度」，默认 400，步长 10。
- 代码广告按配置的宽度预览。超过 400 时等比缩小显示，广告内部的容器宽度不变。

**移动端**：无需改动，移动端广告位不会有 `modalWidth`。

## 4. Auth Requirements

与原接口一致：客户端接口 `permitAll`，可带 JWT；Admin 接口走 IAM SSO。

## 5. Notes & Caveats

- **旧版客户端**不认识 `modalWidth`，仍按 400px 展示。宽版代码广告要按容器宽度自适应：用容器查询，在窄宽度下换成单栏布局。不能只按宽版设计。
- **发布顺序**：先执行 V140，再发 Server，再发 Admin。客户端什么时候发都可以。只发 Server 不发 Admin 时，宽度保持 NULL，行为与之前一致。
- 修改宽度会更新 `updatedAt`，广告版本随之变化，关闭过的用户会再看到一次。
