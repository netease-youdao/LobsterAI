# 客户端侧栏广告位支持代码广告（随主题变化）

日期：2026-11-10
分支：Server / Admin `feat/client-banner-html`（基于 `main`）；客户端 `feat/sidebar-banner-html`（基于 `release/2026.11.9`）

## 1. Change Summary

侧栏广告位（`placement=desktop_sidebar`）原来只能投放图片。现在多一种「代码广告」：

- Admin 配置一段静态 HTML + `<style>`，客户端渲染在 Shadow DOM 里。
- 广告 CSS 用 `var(--lobster-*)` 取客户端主题色。用户切换主题后广告立即跟着变，不需要重新请求。
- 图片广告的行为和数据不变。

数据库新增两列（`sql/V137__client_banner_html.sql`）：

| 列 | 类型 | 说明 |
|---|---|---|
| `content_type` | `VARCHAR(16) NOT NULL DEFAULT 'image'` | `image` 或 `html` |
| `html_content` | `MEDIUMTEXT NULL` | 代码广告内容，最大 64KB |

`image_url` 仍然是 `NOT NULL`。代码广告的图片是给旧版客户端的兜底图，可以不填，不填时存空字符串。

## 2. Endpoint Details

### 客户端：`GET /api/client-banners/snapshot`（`/active`、`/active-list` 同样适用）

新增可选参数 `contentTypes`，值为逗号分隔的能力声明：

```
GET /api/client-banners/snapshot?placement=desktop_sidebar&clientVersion=2026.11.9&contentTypes=image,html
```

| `contentTypes` | 返回内容 |
|---|---|
| 不传（旧客户端） | 只返回有 `imageUrl` 的广告。代码广告有兜底图时会返回，旧客户端按图片展示；没有兜底图时不返回 |
| 包含 `html` | 额外返回没有兜底图的代码广告 |

banner 对象新增两个字段：

```json
{
  "id": 12,
  "activityDescription": "双11充值福利",
  "linkUrl": "https://lobsterai.youdao.com/pricing",
  "imageUrl": "",
  "imageWidth": 800,
  "imageHeight": 250,
  "contentType": "html",
  "htmlContent": "<style>.ad{background:var(--lobster-primary)}</style><div class=\"ad\">…</div>",
  "onlineAt": "2026-11-10T00:00:00",
  "offlineAt": "2026-11-12T00:00:00",
  "updatedAt": "2026-11-10T10:00:00"
}
```

历史数据的 `contentType` 是 `image`，`htmlContent` 是 `null`。

### Admin：`POST /api/admin/app-banners`、`PUT /api/admin/app-banners/{id}`

请求体新增两个可选字段 `contentType` 和 `htmlContent`。不传 `contentType` 时按 `image` 处理，旧版 Admin 不受影响。

`contentType=html` 时的校验：

- `htmlContent` 不能为空，长度不超过 64KB。
- 不能包含 `script`、`iframe`、`frame`、`object`、`embed`、`link`、`meta`、`base`、`form` 标签。
- 不能包含 `on*=` 事件属性，也不能包含 `javascript:`。
- `imageUrl` 可以不填。

校验失败返回 `code != 0`，`message` 为中文原因。

## 3. Frontend Action Items（已在对应分支实现）

### 客户端（LobsterAI）

- `src/main/libs/clientBannerRequest.ts`：snapshot 请求和 legacy active-list 回退请求都带上 `contentTypes=image,html`。
- `sidebarBannerSchedule.ts`：`contentType=html` 且 `htmlContent` 非空的 banner 即使没有 `imageUrl` 也保留。
- `SidebarAdBannerHtml.tsx` 和 `sidebarBannerHtml.ts`：先用 DOMPurify 清洗，再写入 open Shadow DOM。宿主样式为 `display:block; overflow:hidden; contain: layout paint`，内容不会画到广告框外面。
- 清洗规则：
  - 保留 `<style>`（`FORCE_BODY`）。
  - 去掉 `a`、`form`、`button`、`input`、`iframe`、`script` 等标签，以及 `href`、`action`、`target` 等属性。
  - DOMPurify 默认已经去掉 `on*` 属性和 `javascript:`。
- 交互不变：整块点击打开 `linkUrl`，右上角关闭按钮由客户端绘制，轮播和关闭状态的逻辑不变。

### Admin

- 「广告类型」选「代码（随主题变化）」后显示代码编辑框，可以一键插入示例。右侧按 14 套客户端主题实时预览，宽度为默认侧栏宽度 228px。
- 主题变量快照在 `src/utils/clientThemePresets.ts`。客户端新增主题或改主题取值时，需要同步这个文件。

## 4. 广告代码编写约定（给运营和设计）

- 只写 HTML 和 `<style>`，不写脚本。动效用 CSS `@keyframes`。
- 用主题变量取色，常用的有：`--lobster-primary`、`--lobster-primary-foreground`、`--lobster-accent`、`--lobster-surface`、`--lobster-text-primary`、`--lobster-text-secondary`、`--lobster-border`、`--lobster-warning`、`--lobster-radius`。完整列表见客户端 `src/renderer/theme/tokens/contract.ts`。
- 深色主题的差异样式写在 `:host-context(.dark) .xxx { … }` 下。只针对某套主题时写 `:host-context([data-theme="sunset"])`。
- 广告宽度铺满侧栏：默认 228px，用户拖拽侧栏时在 188–388px 之间变化。高度由内容决定。不要写死宽度。
- 内容右上角预留约 24px 给关闭按钮。
- 图片用 `https` 地址，例如 `<img src="https://…">` 或 `background-image: url(https://…)`。

## 5. Auth Requirements

- `/api/client-banners/**` 仍然是 `permitAll`，不需要登录。
- `/api/admin/app-banners/**` 仍然走 Admin IAM，审计日志不变。

## 6. Notes & Caveats

- **发布顺序**：先执行 `sql/V137__client_banner_html.sql`（线上表约 5 行，可以直接执行），再发 Server，然后发 Admin，最后发客户端。旧 Server 会忽略 `contentTypes`，新客户端连旧 Server 只会拿到图片广告。
- **向后兼容**：已有接口路径、字段和错误码都不变，新参数和新字段都是可选的。旧客户端看不到没有兜底图的代码广告。需要覆盖旧版本用户时，给代码广告上传一张兜底图。
- 「最低客户端版本」仍然生效，和 `contentTypes` 是两个独立的过滤条件。
- Server 校验只是第一道拦截，客户端渲染前还会再用 DOMPurify 清洗一次，不要依赖某一层单独防护。
- 广告关闭状态以 `id:updatedAt` 为版本。修改广告代码会更新 `updatedAt`，用户之前关闭过的广告会重新出现，和图片广告的行为一致。
