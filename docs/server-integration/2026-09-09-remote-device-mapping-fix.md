# 远控设备凭证校验：服务端字段映射修复

日期：2026-09-09。

## 变更摘要

修复桌面成功注册后查询设置返回 `47013 / DEVICE_CREDENTIAL_INVALID` 的问题。当前服务端 MyBatis 数据源没有开启下划线转驼峰，远控实体查询缺少结果映射，使数据库中已有的用户身份和凭证哈希未正确读入 Java 属性。已为远控 Mapper 补齐显式映射；桌面请求头已用隔离 Electron 回显确认完整。

## 接口与认证

接口、参数和认证保持原协议。恢复接入仍使用既有账号 JWT 和原设备密钥：

```http
GET /api/remote/v1/devices/{deviceId}/settings
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
```

成功后读取原 `settingsVersion`，再由桌面持久队列调用同路径 `PATCH` 发布待同步设置。例如：

```json
{
  "remoteEnabled": true,
  "protocolVersion": 1,
  "capabilities": ["session.read", "session.create", "session.continue", "run.cancel", "approval.respond", "same_account_access"],
  "workspaces": [{"workspaceId": "<existingWorkspaceId>", "name": "project", "available": true}],
  "expectedSettingsVersion": "1"
}
```

标准响应仍为 `{ "code": 0, "message": "success", "data": { ... } }`；PATCH 返回最新版本，实际字段与值沿用远控 v1 接入文档。发布设置后通过 `POST /api/remote/v1/connection-tickets` 获取一次性票据，连接其返回的 WSS 地址。

## 桌面和 App 接入事项

- 发布此服务端修复，所有节点更新完成后在桌面点击“重新连接”。新版桌面遇到 47013 会暂停自动重试，所以需显式触发。
- 继续使用原 installationId、deviceId、deviceKey 与本地任务队列，补送待同步设置和会话；不要删除设备或换密钥。
- App 沿用原注册、设备列表、访问授权和 WS 订阅流程；不需要新增接口或参数。
- 校验仍严格绑定 JWT 中的用户及个人/团队身份；此次修复不会绕过真实无效凭证。

## 兼容与验证

无新增 DDL，无需再次执行 V88；兼容 MySQL 5.7。无需修改 nginx、WS 入口、Portal 或 Admin。仅修复远控结果映射，不开启全局驼峰映射影响其他业务。

测试库仅作只读登记检查，未修改数据；服务端测试按要求未执行。修复后的真实连接恢复需在发布后检查：设置查询不再误报 47013、待同步状态清除、WS 收到 hello 后显示在线。
