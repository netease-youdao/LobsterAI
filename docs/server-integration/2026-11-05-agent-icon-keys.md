# Agent 内置头像标识接入（2026-11-05）

## 变更摘要

远控 Agent 目录与会话摘要的既有 `icon: string | null` 支持桌面原始内置标识，例如 `agent-avatar-svg:code`。App 内置同一套资源，以完整字符串查表即可显示。沿用原字段，不新增 URL、资源服务或服务端数据库结构；本轮不修改手机 App 源码，专家 CDN 图片继续为 null，由 App 默认头像兜底。此前模型 `modelId` 变更独立保留。

详细方案及手机接入契约见服务端的 `docs/specs/mobile-remote-control/feature-2026-11-05-agent-icon-keys.md`、`docs/api/mobile-remote-api.md` 与 `docs/integration/2026-11-05-agent-icon-keys.md`。

## 接口与认证

- `GET /api/remote/v1/capabilities`：使用 JWT Bearer 与既有环境头，不要求设备凭据。Agent 摘要启用时，`data.capabilities` 新增 `agent_icon_keys_v1`。
- `PUT /api/remote/v1/devices/{deviceId}/agents`：沿用 publicationId、expectedCatalogVersion、connectionGeneration 和 items；只扩展既有 icon 的合法值。
- `GET /api/remote/v1/devices/{deviceId}/agents`：App 使用 `data.items[].icon`。
- 现有会话列表、快照、HTTP 投影与 `session.upsert`：App 使用 `session.agent.icon`，不需再查单个 Agent。

目录及会话接口继续要求 JWT、调用设备自己的 `X-Remote-Device-Credential: <callerDeviceId>.<callerDeviceKey>` 和原有投影/环境头。账号、scope、目标设备、同步资格、连接代次的认证与授权不变。新增能力只描述展示格式，不加入设备执行能力声明；没有头像能力时只回退 icon，不禁用 Agent 选择器。

目录发布的既有请求示例（版本和 ID 均为示例）：

```json
{
  "publicationId": "7309dbf9-e3cd-4401-8cff-be4e04a83275",
  "expectedCatalogVersion": "4",
  "connectionGeneration": "3",
  "items": [{
    "agentId": "main", "name": "主 Agent", "kind": "default",
    "version": "8", "icon": "agent-avatar-svg:code", "enabled": true,
    "defaultWorkspaceId": "workspace_main", "workspaceAvailable": true,
    "unavailableReason": null
  }]
}
```

GET 响应继续采用 `{ "code": 0, "message": "success", "data": { ... } }`，其 `data.items` 返回上述条目并保留既有 deviceId、catalogVersion、syncStatus 等字段；PUT 回执保留 deviceId、publicationId、catalogVersion、syncedAt。会话示例：

```json
{
  "agent": {
    "agentId": "main", "name": "主 Agent", "kind": "default",
    "version": "8", "icon": "agent-avatar-svg:code", "state": "available"
  }
}
```

服务端允许完整匹配 `agent-avatar-svg:[a-z][a-z0-9-]{0,63}` 的值，原总长度限制仍为 128 UTF-8 字节。合法未来 key 可透传，由 App 未知值兜底；当前桌面仅发布 `parseAgentAvatarIcon()` 识别的 30 个内置 key。旧简单标识、emoji、null 保留原行为；图片 URL、路径、HTML/SVG 源码、非法或未知桌面编码投影为 null。标识不是 URL，不应执行或拼接任意路径。

## 桌面实现与兼容

`RemoteBridge` 先验证当前服务目标、设置投影身份，再根据 `agent_icon_keys_v1` 配置 `RemoteAgentCatalog`，最后安装会话摘要 resolver。目录和会话共用头像投影；缺能力时继续旧格式。

投影状态按服务 target、用户、scope、agentId 保存，包含来源安全值、公开 icon、Agent version 和已确认能力。首次 null→key、明确能力关闭及重新开启只在实际投影变化时推进 Agent version。重复配置、刷新、重连和重启不会持续加版本；尚未完成协商时保留上次已确认展示，不能把未知态当作关闭。迁移同时核对已有摘要缓存，兼容用户期间退回旧桌面写入的更高版本记录。

桌面在既有本地状态表保存投影记录，并新增 SQLite 触发器：Agent version 的推进在同一事务中更新关联会话的旧版投影 revision 和 v3 control revision；用户后续修改头像也能产生 `session.upsert`，不依赖目录刷新。迁移不修改 owner、Agent ID、工作区或执行权限。已删除 Agent 只依据最新可靠历史证据显示头像；不能用过期记录恢复头像，也不会恢复执行权限。

已封装的目录发布、快照、增量批次保留原 ID、内容及 hash。升级或明确关闭能力不改写在途请求；先按原流程完成/对账，再发布更高 Agent version 的新摘要。

## App 行动项

1. 从 `src/renderer/assets/agent-avatars/` 内置原 30 个 SVG，或在构建时转换成平台支持的矢量/位图。用完整字符串建立显式映射，例如 `agent-avatar-svg:code → code.svg`；定义来源为 `src/shared/agent/avatar.ts`。桌面 SVG 按模板前景色渲染，App 同样需要支持明暗主题着色。
2. Agent 列表、会话列表和聊天页共用映射。null、未知 key、专家图片或资源加载失败使用内置 lobster 默认头像；emoji 沿用旧逻辑。
3. 缓存按服务目标、账号/scope、deviceId、agentId 隔离，用十进制字符串 Agent version 合并，避免旧摘要覆盖新头像；收到 Agent 目录变更事件后重新拉取。
4. 会话事件仍按连续 seq 应用；不能因旧 Agent version 丢弃整个会话事件。匿名或已删除 Agent 的本人历史使用会话摘要，不能因为目录中没有该项就改绑 main。

## 发布与回滚

先全量部署能读取和写入新前缀的服务端，再发布新桌面和 App 映射。单次能力查询不能证明混部节点全部兼容。只升级服务端不能从历史 null 反推出原图标。

写入新前缀后，最低服务端回滚版本必须保留新格式读取能力；不能直接回滚到拒绝此格式的旧严格二进制。兼容服务端撤销能力公告时，桌面用更高版本回退新生成摘要；在途请求仍保持原内容。

服务端无 MySQL SQL/DDL 及新版本特性，兼容 MySQL 5.7；桌面本地投影状态与 SQLite 触发器不影响服务端数据库。当前代码验证不代表已部署或已完成 App 真机验收；App 未知值容错与实际图标呈现仍需接入方验证。

## 本次验证

使用 Node.js 24.17.0，AgentCatalog、RemoteBridge、AgentOwnership、RemoteStore、library triggers、ProjectionCoordinator、AvailabilityPublisher 共 7 个定向 Vitest 文件的 324 项用例通过；Electron TypeScript 编译通过，8 个改动 TypeScript 文件按 CI 规则执行 ESLint 零错误、零警告。独立 AI 复核发现的同版本头像冲突、过期删除头像恢复及 v3 历史会话同步问题均已修复并加入回归。服务端测试按项目约定未执行。
