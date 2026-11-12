# 广告位：桌面端广告支持应用内跳转（deeplink）

日期：2026-11-12
前置文档：[`2026-11-12-client-banner-modal-width.md`](2026-11-12-client-banner-modal-width.md)

分支：
- Server、Admin：`feat/client-banner-html`
- 客户端：`feat/sidebar-banner-html`

## 1. Change Summary

- 桌面端广告（`desktop_launch_modal`、`desktop_sidebar`）的「链接」除了 http(s) 地址，还可以填应用内链接。用户点击广告后在客户端里跳转到对应页面，不打开浏览器。
- 链接格式：

  | 格式 | 行为 |
  |---|---|
  | `lobsterai://settings/{tab}` | 打开设置并定位到对应页 |
  | `lobsterai://view/{view}` | 关闭设置，切换主界面 |

- 目前支持的取值（客户端白名单，见 `src/renderer/services/appDeepLink.ts`）：
  - `settings`：`general`、`appearance`、`desktopCompanion`（悬浮球）、`coworkAgentEngine`、`model`、`im`、`browserWebAccess`、`email`、`coworkMemory`、`coworkDreaming`、`plugins`、`experimental`、`shortcuts`、`help`、`about`
  - `view`：`cowork`（新建任务）、`experts`、`kits`、`skills`、`mcp`（连接器）、`scheduledTasks`、`library`
- 移动端广告位仍只接受 http(s)。
- 没有数据库变更。

## 2. Endpoint Details

接口路径、参数、响应结构都不变，只是 `linkUrl` 的取值范围扩大了：

```json
{ "id": 18, "placement": "desktop_launch_modal", "linkUrl": "lobsterai://settings/desktopCompanion" }
```

Admin 保存（`POST/PUT /api/admin/app-banners`）的校验：
- http(s) 地址：和以前一样。
- 桌面端广告位：额外接受匹配 `^lobsterai://(settings|view)/[A-Za-z]+/?$` 的链接，首尾空格会被去掉。Server 只校验格式，具体页面由客户端白名单决定。
- 移动端广告位，或不符合格式的链接（例如 `lobsterai://auth/callback`）：报错「链接必须是有效的 http(s) 地址…」。

## 3. Frontend Action Items

**Electron（已实现）**
- 新增 `services/appDeepLink.ts`：解析链接，并派发 `app:deepLinkNavigate` window 事件。`App.tsx` 监听这个事件，调用 `handleShowSettings` 或切换主视图。
- `components/clientBannerLink.ts`：侧栏广告和开屏弹窗共用的点击处理。
  - `lobsterai://` 链接在应用内跳转。这个版本不认识的页面只记一条诊断日志，不交给系统打开，避免绕回本应用的协议处理。
  - 其他链接仍走 `getClientBannerTargetUrl` 加 `openExternal`。

**Admin（已实现）**
- 「链接」输入框旁边加了「或选择应用内页面」下拉框，选中后自动填入链接。
- 校验规则与 Server 一致。
- 列表里应用内链接显示为「应用内 · 页面名」，不渲染成可点击的链接。

**移动端**：无改动。

## 4. Auth Requirements

与原接口一致。

## 5. Notes & Caveats

- **旧版客户端不支持**：点击时会调用系统打开 `lobsterai://…`，最后回到 LobsterAI 自己，什么都不会发生。配置应用内跳转的广告时，**请把「最低客户端版本」设为包含本功能的客户端版本**。
- 客户端新增可跳转页面时，同时更新：客户端白名单、Admin 下拉选项（`src/utils/clientBannerLinks.ts`）、本文档。Server 只校验格式，不需要改。
- 系统级的 `lobsterai://` 协议（例如从浏览器唤起）仍然只处理登录回调，不处理这些页面跳转。
