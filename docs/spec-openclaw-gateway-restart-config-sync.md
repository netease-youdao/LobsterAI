# OpenClaw Gateway 配置同步与插件 stale entry 修复 Spec

## 问题描述

用户正常使用 LobsterAI Cowork 时，未主动修改配置，但 OpenClaw gateway 在后台突然收到 `SIGTERM` 并重启。日志中同时出现了插件配置 warning：

```text
[Auth:getModels] Fetching: https://lobsterai-server.youdao.com/api/models/available
[Auth:getModels] Response status: 200
[GW-RESTART-DIAG] syncOpenClawConfig START reason=server-models-updated
[GW-RESTART-DIAG] needsHardRestart=true
[GW-RESTART-DIAG] HARD RESTART EXECUTING
[gateway] signal SIGTERM received
```

以及：

```text
plugins.entries.qwen-portal-auth: plugin not found
plugins.entries.clawemail-email: plugin not found
plugins.entries.openclaw-nim-channel: plugin not found
```

需要满足以下目标：

1. 模型列表轮询不应在内容未变化时触发 OpenClaw config sync
2. 服务端模型元数据变化时，可以同步配置，但不应主动要求 gateway hard restart
3. `plugins.entries` 只能写入 OpenClaw 实际识别的插件 manifest id
4. 历史遗留的 stale plugin entry 应在同步时自动迁移清理
5. Email、NIM 插件包存在时，应按通道配置正确启用，而不是因为目录名和 manifest id 不一致被误判为不存在

---

## 核心结论

**`package.json` 中的 OpenClaw plugin id 是 LobsterAI 用来安装/定位插件包的 package/directory id；OpenClaw runtime 校验 `plugins.entries` 时使用的是插件 `openclaw.plugin.json` 里的 manifest id。两者不能混用。**

| 插件包目录 / package id | manifest id | `plugins.entries` 应写入 |
|---|---|---|
| `clawemail-email` | `email` | `email` |
| `openclaw-nim-channel` | `nimsuite-openclaw-nim-channel` | `nimsuite-openclaw-nim-channel` |
| `qwen-portal-auth` | 当前 runtime 未安装 | 不写入 |

因此，`package.json` 里有 `clawemail-email` 和 `openclaw-nim-channel` 只能说明 LobsterAI 会安装这两个插件包，不代表 `openclaw.json` 里可以使用同名 entry。

---

## 触发链路

### 修复前

```
Renderer refreshes available models
  → IPC auth:getModels
  → GET /api/models/available
  → updateServerModelMetadata(data.data)
  → syncOpenClawConfig(reason=server-models-updated)
  → rewrite openclaw.json
  → gateway sees a config change
  → may escalate from reload to hard restart
  → stale plugins.entries are still preserved and logged as warnings
```

这个链路的问题是：即使模型列表内容没有变化，也会执行一次配置同步；而历史 stale entry 又会让 gateway 在启动或 reload 时持续产生无效插件 warning，污染配置状态并增加排查难度。两类问题需要同时修复，但不能把 stale entry 简化成每一次 hard restart 的唯一直接原因。

### 修复后

```
Renderer refreshes available models
  → IPC auth:getModels
  → GET /api/models/available
  → updateServerModelMetadata(data.data) returns changed:boolean
  → unchanged: skip config sync
  → changed: syncOpenClawConfig(reason=server-models-updated, restartGatewayIfRunning=false)
  → config sync writes only manifest plugin ids
  → legacy package ids are removed from plugins.entries
```

---

## 设计原则

1. **按语义变化同步配置。** 服务端模型元数据只有在 `modelId` 或 `supportsImage` 变化时才触发 OpenClaw config sync；返回顺序变化不视为内容变化。
2. **config entry 使用 runtime id。** 所有 `plugins.entries` key 都必须是 OpenClaw manifest id，而不是 npm 包名、安装目录名或 LobsterAI package id。
3. **插件不存在就不写入。** `qwen-portal-auth` 这类 runtime 未安装插件不能因为 provider URL 命中而无条件写入。
4. **保留 runtime 注入字段。** 继续保留 gateway/runtime 自动注入的 `plugins` 和 `gateway` 字段，避免因为 LobsterAI 重写配置导致新的 diff loop。
5. **迁移历史配置。** 对旧版本写入的 package/directory id 做自动清理，不要求用户手动编辑 `openclaw.json`。

---

## 详细修复

### 1. 服务端模型元数据 diff

`updateServerModelMetadata()` 从单纯更新缓存改为返回 `boolean`：

```typescript
const serverModelsChanged = updateServerModelMetadata(data.data);
if (serverModelsChanged) {
  syncOpenClawConfig({
    reason: 'server-models-updated',
    restartGatewayIfRunning: false,
  }).catch(() => {});
}
```

比较逻辑只关注 OpenClaw config 需要的字段：

```typescript
{
  modelId,
  supportsImage,
}
```

并按 `modelId` 排序后比较，避免服务端仅调整返回顺序时触发无意义同步。

### 2. 插件 manifest id 解析

新增 OpenClaw 插件 manifest 扫描能力：

```typescript
resolveOpenClawExtensionPluginId(extensionId)
```

该函数会扫描 bundled third-party extensions 和本地 extensions，支持用以下任一 id 查询：

1. 插件目录名，例如 `clawemail-email`
2. manifest id，例如 `email`

返回值始终是 OpenClaw runtime 校验所需的 manifest id。

### 3. `plugins.entries` 写入真实插件 id

配置同步读取 `package.json` 中的预装插件列表后，会先解析成：

```typescript
{
  packageId: string;
  pluginId: string;
}
```

然后统一用 `pluginId` 写入：

```typescript
return [plugin.pluginId, { enabled: pluginEnabled }];
```

Email 与 NIM 的启用判断同时兼容 package id 和 manifest id：

```typescript
pluginMatches(plugin, 'clawemail-email', 'email')
pluginMatches(plugin, 'openclaw-nim-channel', 'nimsuite-openclaw-nim-channel', 'nim')
```

这样可以保证：

1. `package.json` 仍用原有 package id 管理安装
2. `openclaw.json` 写入 runtime 能识别的 manifest id
3. UI 未启用对应通道时，插件 entry 会保持 disabled

### 4. stale entry 清理

配置同步会从既有 `plugins.entries` 中删除以下历史无效 key：

```typescript
dingtalk
openclaw-nim-channel
clawemail-email
qwen-portal-auth
openclaw-qqbot
```

同时也会删除所有已知 package alias id，例如 package id 与 manifest id 不一致的插件目录名。

清理后重新写入：

```json
{
  "plugins": {
    "entries": {
      "email": { "enabled": true },
      "nimsuite-openclaw-nim-channel": { "enabled": true }
    }
  }
}
```

### 5. Qwen portal auth 保护

旧逻辑在检测到 DashScope/Qwen provider URL 时，会无条件写入：

```json
{
  "qwen-portal-auth": { "enabled": true }
}
```

新逻辑先检查 runtime 是否真的安装了该插件：

```typescript
const qwenPortalAuthPluginId = resolveOpenClawExtensionPluginId('qwen-portal-auth');
```

只有插件存在时才写入：

```typescript
...(hasQwenProvider && qwenPortalAuthPluginId
  ? { [qwenPortalAuthPluginId]: { enabled: true } }
  : {})
```

当前 runtime 未安装 `qwen-portal-auth`，因此不会再生成 stale entry。

---

## 本地配置迁移

用户本机配置文件：

```text
~/Library/Application Support/LobsterAI/openclaw/state/openclaw.json
```

已移除历史 stale entries：

```text
qwen-portal-auth
openclaw-nim-channel
clawemail-email
```

迁移前已备份：

```text
~/Library/Application Support/LobsterAI/openclaw/state/openclaw.json.bak-2026-04-28T15-46-16-321Z
```

后续应用启动或配置同步时，代码会自动保持这种迁移结果，不会再写回这些无效 key。

---

## 涉及文件清单

| 文件 | 角色 |
|------|------|
| `src/main/main.ts` | `auth:getModels` 仅在服务端模型元数据变化时触发配置同步 |
| `src/main/libs/claudeSettings.ts` | 缓存服务端模型元数据，并返回内容是否变化 |
| `src/main/libs/openclawLocalExtensions.ts` | 读取插件 `openclaw.plugin.json`，解析 directory id 到 manifest id |
| `src/main/libs/openclawConfigSync.ts` | 使用 manifest id 写入 `plugins.entries`，清理 stale entry，保护 qwen portal auth |
| `src/main/libs/openclawConfigSync.runtime.test.ts` | 覆盖 package id 到 manifest id 的迁移行为 |

---

## Review 结论

本次修复方向合理，原因如下：

1. **根因覆盖完整。** 同时处理了无变化模型轮询触发 config sync，以及插件 entry id 写错导致的 stale config。
2. **行为边界收窄。** 只在模型元数据实际变化时同步配置，且同步时不主动 hard restart gateway。
3. **兼容历史配置。** 既保留已有 runtime 注入字段，又清理明确无效的历史 key。
4. **不破坏插件安装模型。** `package.json` 仍以 package id 管理插件安装，OpenClaw runtime 配置则使用 manifest id。
5. **缺失插件不再写入。** `qwen-portal-auth` 只有真实存在时才进入 `plugins.entries`。

剩余风险主要来自 OpenClaw 未来版本可能再次调整插件 manifest id。该风险由 manifest 扫描机制承接，只要插件包内 `openclaw.plugin.json` 正确，LobsterAI 不需要硬编码新 id。

---

## 验证方法

### 自动化验证

```bash
npm test -- openclawConfigSync
npm run compile:electron
npm run build
git diff --check
```

### 定向 lint

```bash
./node_modules/.bin/eslint \
  src/main/libs/claudeSettings.ts \
  src/main/main.ts \
  src/main/libs/openclawLocalExtensions.ts \
  src/main/libs/openclawConfigSync.ts \
  src/main/libs/openclawConfigSync.runtime.test.ts
```

全量 `npm run lint` 当前仍会命中仓库既有无关 lint 问题，本次改动文件没有新增 lint error。

### 手工验证

1. 启动 LobsterAI
2. 正常进入 Cowork 使用
3. 等待 renderer 刷新模型列表或手动触发模型列表请求
4. 检查日志不应反复出现：

```text
syncOpenClawConfig START reason=server-models-updated
HARD RESTART EXECUTING
plugins.entries.qwen-portal-auth: plugin not found
plugins.entries.clawemail-email: plugin not found
plugins.entries.openclaw-nim-channel: plugin not found
```

5. 如果服务端模型能力确实变化，应只看到一次 `server-models-updated` 配置同步，且不主动执行 hard restart。

### 回归场景

| 场景 | 预期 |
|------|------|
| 模型列表内容未变化 | 不触发 OpenClaw config sync |
| 模型 `supportsImage` 变化 | 触发 config sync，但不主动 hard restart |
| Email 通道启用 | `plugins.entries.email.enabled=true` |
| Email 通道未启用 | `plugins.entries.email.enabled=false` |
| NIM 通道启用 | `plugins.entries.nimsuite-openclaw-nim-channel.enabled=true` |
| NIM 通道未启用 | `plugins.entries.nimsuite-openclaw-nim-channel.enabled=false` |
| Qwen provider 存在但插件缺失 | 不写入 `qwen-portal-auth` |
| 旧配置已有 package alias key | 同步后自动删除 alias key |

---
