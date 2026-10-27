# 设备管理隐藏连接额度数字

日期：2026-10-27。状态：客户端已实施，测试、类型检查、严格 lint 与真实 Electron 页面验证通过；未打包发布。

## 1. 目标

设备管理展示实际电脑和连接状态，不将“已连接 1 / 5”“最多连接 N 台”作为常驻界面信息。后台调整额度不要求客户端同步改文案；不改变现有服务端准入限制。

## 2. 展示规则

- “当前电脑”标题右侧仅保留刷新图标，沿用现有尺寸、间距、主题颜色、title 和无障碍名称。
- 删除已连接数/上限及未知数字占位，包括 `1 / 5`、`6 / 5`、`— / 5`、`— / —`，不替换为其他数量文案。
- 设备管理说明使用无数字的账号/空间规则，说明手机不占电脑名额、短暂断线保留名额。帮助不再订阅连接额度快照。
- 仍显示每台电脑的真实名称、在线/重连/移除状态和可用操作，不隐藏其他已连接电脑。
- 名额满时保留“等待连接”“同步暂停”“连接名额已满，当前电脑同步已暂停。本地任务可正常使用。”及管理连接/重试入口。
- 获得可靠的新额度后，继续按服务端实际 quota 判断可用名额，保留“连接名额已释放，正在尝试连接”的恢复提示。
- presence 或列表查询失败时，保留状态不可用和上次更新时间，不以省略数字掩盖故障；刷新时仍禁用按钮并显示加载动画。
- 旧服务端不支持连接管理时继续保留当前电脑和已有恢复能力，不显示不可用的管理入口。

## 3. 服务端与兼容边界

本次无服务端 API、认证、数据结构、MySQL 或手机源码变更。仍解析 `GET /api/remote/v2/device-connections` 的 `quota.maxOnlineDesktops`、`onlineSlotsUsed` 和 `scope`，不删字段、不在客户端回填固定额度。

只读核对服务端代码：

- `application.properties`：`remote-control.limits.max-online-desktops=${REMOTE_MAX_ONLINE_DESKTOPS:5}`，默认值 5 是服务端配置，不是客户端上限。
- `RemoteDeviceConnectionService.list()` 与 capabilities 返回当前配置；准入、HTTP 409 / 47022 / ONLINE_DESKTOP_LIMIT 和重试退避继续由服务端执行。
- 现有配置校验要求在线上限不超过登记上限。多节点配置需一致。当前未发现对应 Admin 编辑接口或热刷新绑定，调整按现有服务端配置发布流程生效；本次不新增免重启实时调额功能。

## 4. 实施文件

- `src/renderer/components/remote/RemoteDeviceConnectionList.tsx`：删除摘要计数，保留刷新和连接列表。
- `src/renderer/components/remote/RemoteDeviceHelp.tsx`：使用无数字说明，去除不再使用的额度读取/订阅。
- `src/renderer/services/i18n.ts`：仅删除本次变成孤立的 `remoteConnectedSummary`、`remoteConnectionLimitHelp` 中英翻译。
- `src/renderer/components/remote/RemoteDeviceConnectionList.test.ts`：调整已有数字展示断言；列表、加载、故障、旧服等行为覆盖继续保留。
- `docs/server-integration/2026-09-18-device-connection-management.md`：同步桌面展示约定。

本次只涉及 LobsterAI 客户端。服务端、Portal、Admin、手机源码均未修改；未更改实际服务器额度。

## 5. 验证记录

- 相关 4 个 Vitest 文件共 95 项通过：`RemoteDeviceConnectionList.test.ts`、`RemoteDeviceSettings.test.ts`、`remoteDeviceConnections.test.ts`、`remoteControlState.test.ts`。
- Renderer `tsc --noEmit -p tsconfig.json` 通过；4 个触碰 TS/TSX 文件严格 ESLint 和 diff whitespace 检查通过。
- 运行中的 Electron 开发版（localhost:5175）人工打开设置 → 设备管理：当前设备在线、刷新与重命名入口存在，没有连接计数。打开帮助确认无具体上限，Escape 仅关闭帮助、设置页保留。未修改用户设置、设备名称或连接权限。
- 仓库外 `/tmp/lobsterai-session-hover-preview-20261027/devices.html` 使用实际组件和主题、受控服务边界：验证浅色/深色、名额满、服务端 quota fixture 从 1 调到 20 后恢复提示变化、列表故障仍显示且当前电脑保持在线。未访问或变更真实后台额度。
- 服务端仅只读核对代码，按项目约定未运行服务端测试；未打包、部署或提交。

## 6. 下载占位提示精简（2026-10-27）

根据用户追加要求，官网二维码模式不再显示“手机 App 下载入口准备中”及对应英文文案，也不渲染该提示行的间距。横幅保留标题、功能说明与“扫码访问官网”标签；二维码 URL 不变。真实 App 下载模式继续显示同账号登录提示，不将官网链接表述为下载地址。删除无消费者的中英文翻译键及仅引用该键的旧弹层测试断言。本次仍仅涉及客户端展示，无服务端或接口变更。

本轮复验：`RemoteDeviceSettings.test.ts` 与 `RemoteControlPopover.test.ts` 共 44 项通过；renderer TypeScript、3 个触碰文件严格 ESLint、diff whitespace 检查通过。实际组件预览确认官网二维码、标题和功能说明保留，下载准备提示及对应 DOM 行均消失。
