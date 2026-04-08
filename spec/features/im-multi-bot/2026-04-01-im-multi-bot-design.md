# IM 多机器人实例设计文档

## 1. 概述

LobsterAI 原有的 IM 接入架构中，钉钉、飞书、QQ 三个平台均为**单机器人**模式 — 每个平台仅支持配置一组凭证（如一个 `clientId` + `clientSecret`）。本次变更将这三个平台升级为**多实例（Multi-Instance）**模式，允许用户为同一平台配置多个独立的机器人实例，每个实例拥有独立的凭证、策略和状态。

### 设计目标

1. **同一平台可同时运行多个机器人** — 例如同时接入两个钉钉机器人，分别用于客服和技术支持
2. **每个实例独立配置** — 独立的 AppID/AppSecret、消息策略、群聊策略等
3. **每个实例独立状态** — 独立的连接状态、错误信息、最后收发消息时间
4. **向后兼容** — 自动将单实例旧配置迁移为多实例格式，无需用户手动操作
5. **最多 5 个实例** — 每个平台最多支持 5 个机器人实例（`MAX_*_INSTANCES = 5`）

### 影响范围

- **受影响平台**：钉钉（DingTalk）、飞书（Feishu）、QQ
- **未受影响平台**：Telegram、Discord、云信（NIM）、企业微信（WeCom）、POPO、微信 — 仍为单实例模式

---

## 2. 数据模型设计

### 2.1 类型定义

每个多实例平台引入四个新类型（以钉钉为例）：

```typescript
// src/main/im/types.ts & src/renderer/types/im.ts

interface DingTalkInstanceConfig extends DingTalkOpenClawConfig {
  instanceId: string;      // UUID，唯一标识
  instanceName: string;    // 用户自定义名称，如 "客服机器人"
}

interface DingTalkInstanceStatus extends DingTalkGatewayStatus {
  instanceId: string;
  instanceName: string;
}

interface DingTalkMultiInstanceConfig {
  instances: DingTalkInstanceConfig[];
}

interface DingTalkMultiInstanceStatus {
  instances: DingTalkInstanceStatus[];
}
```

飞书和 QQ 遵循相同模式：`FeishuInstanceConfig`、`QQInstanceConfig` 等。

### 2.2 配置存储结构

**旧模式**（单实例）：

```
im_config 表:
  key: 'dingtalkOpenClaw'  →  value: { enabled, clientId, clientSecret, ... }
  key: 'feishuOpenClaw'    →  value: { enabled, appId, appSecret, ... }
  key: 'qq'                →  value: { enabled, appId, appSecret, ... }
```

**新模式**（多实例）：

```
im_config 表:
  key: 'dingtalk:<instanceId>'  →  value: { instanceId, instanceName, enabled, clientId, ... }
  key: 'feishu:<instanceId>'    →  value: { instanceId, instanceName, enabled, appId, ... }
  key: 'qq:<instanceId>'        →  value: { instanceId, instanceName, enabled, appId, ... }
```

每个实例以 `{platform}:{instanceId}` 为 key 独立存储。旧的单一 key（如 `dingtalkOpenClaw`）在迁移后删除。

### 2.3 顶层配置类型变更

```typescript
// 旧
interface IMGatewayConfig {
  dingtalk: DingTalkOpenClawConfig;
  feishu: FeishuOpenClawConfig;
  qq: QQOpenClawConfig;
  // ...
}

// 新
interface IMGatewayConfig {
  dingtalk: DingTalkMultiInstanceConfig;  // { instances: [...] }
  feishu: FeishuMultiInstanceConfig;
  qq: QQMultiInstanceConfig;
  // ...
}
```

`IMGatewayStatus` 同样从单一状态对象改为 `{ instances: [...] }` 结构。

---

## 3. 存储层变更

### 3.1 IMStore 新增方法

**文件**：`src/main/im/imStore.ts`

每个多实例平台新增 CRUD 方法：

| 方法 | 说明 |
|------|------|
| `getDingTalkInstances()` | 查询所有 `dingtalk:*` key，返回实例数组 |
| `getDingTalkInstanceConfig(instanceId)` | 查询单个实例配置 |
| `setDingTalkInstanceConfig(instanceId, config)` | 创建/更新实例配置（merge） |
| `deleteDingTalkInstance(instanceId)` | 删除实例配置 + 关联的 session mappings |
| `getDingTalkMultiInstanceConfig()` | 返回 `{ instances: [...] }` 包装 |
| `setDingTalkMultiInstanceConfig(config)` | 批量写入所有实例 |

飞书和 QQ 有对应的同名方法（`getFeishuInstances`、`getQQInstances` 等）。

旧方法（如 `getDingTalkOpenClawConfig`、`setQQConfig`）标记为 `@deprecated`，保留向后兼容。

### 3.2 数据迁移

**文件**：`src/main/im/imStore.ts` — `ensureMigrations()` 方法

迁移逻辑在 IMStore 初始化时自动执行，对三个平台分别处理：

```
迁移流程（以 QQ 为例）：
1. 检查旧 key 'qq' 是否存在 且 新 key 'qq:*' 尚无记录
2. 读取旧配置 JSON
3. 生成 UUID 作为 instanceId
4. 写入新 key 'qq:<instanceId>'，instanceName 默认 'QQ Bot 1'
5. 删除旧 key 'qq'
6. 迁移 session mappings: UPDATE platform = 'qq:<instanceId>' WHERE platform = 'qq'
7. 迁移 agent bindings: platformAgentBindings['qq'] → platformAgentBindings['qq:<instanceId>']
```

三个平台的迁移逻辑完全对称：
- QQ: `'qq'` → `'qq:<id>'`
- 飞书: `'feishuOpenClaw'` → `'feishu:<id>'`
- 钉钉: `'dingtalkOpenClaw'` → `'dingtalk:<id>'`

### 3.3 实例删除

删除实例时同时清理关联数据：
```typescript
deleteDingTalkInstance(instanceId: string): void {
  this.db.run('DELETE FROM im_config WHERE key = ?', [`dingtalk:${instanceId}`]);
  this.db.run('DELETE FROM im_session_mappings WHERE platform = ?', [`dingtalk:${instanceId}`]);
  this.saveDb();
}
```

---

## 4. 网关状态管理

### 4.1 状态结构变更

**文件**：`src/main/im/imGatewayManager.ts`

旧模式返回单一状态对象，新模式返回实例状态数组：

```typescript
// 旧
const dingtalkStatus = {
  connected: Boolean(dtConfig?.enabled && dtConfig.clientId && dtConfig.clientSecret),
  startedAt: null, lastError: null, ...
};

// 新
const dingtalkStatus = {
  instances: (config.dingtalk?.instances || []).map(inst => ({
    instanceId: inst.instanceId,
    instanceName: inst.instanceName,
    connected: Boolean(inst.enabled && inst.clientId && inst.clientSecret),
    startedAt: null, lastError: null, ...
  })),
};
```

### 4.2 连接判断

`isAnyConnected()` 方法适配多实例：

```typescript
// src/renderer/services/im.ts
isAnyConnected(): boolean {
  const status = this.getStatus();
  return PlatformRegistry.platforms.some(p => {
    const s = status[p];
    if (p === 'qq' || p === 'feishu' || p === 'dingtalk') {
      return (s as any)?.instances?.some((i: any) => i.connected);
    }
    return (s as any)?.connected;
  });
}
```

### 4.3 平台配置检测

`isPlatformConfigured()` 在 Agent 设置面板中适配：

```typescript
// src/renderer/components/agent/AgentSettingsPanel.tsx
const isPlatformConfigured = (platform: Platform): boolean => {
  if (platform === 'qq' || platform === 'feishu' || platform === 'dingtalk') {
    return (imConfig[platform] as any)?.instances?.some((i: any) => i.enabled) ?? false;
  }
  return (imConfig[platform] as any)?.enabled === true;
};
```

---

## 5. OpenClaw 配置同步

### 5.1 接口变更

**文件**：`src/main/libs/openclawConfigSync.ts`

依赖注入接口从单配置改为实例列表：

```typescript
// 旧
type OpenClawConfigSyncDeps = {
  getDingTalkConfig: () => DingTalkOpenClawConfig | null;
  getFeishuConfig: () => FeishuOpenClawConfig | null;
  getQQConfig: () => QQOpenClawConfig | null;
};

// 新
type OpenClawConfigSyncDeps = {
  getDingTalkInstances: () => DingTalkInstanceConfig[];
  getFeishuInstances: () => FeishuInstanceConfig[];
  getQQInstances: () => QQInstanceConfig[];
};
```

### 5.2 多实例 → OpenClaw accounts 映射

OpenClaw 使用 `accounts` 字典支持同一 channel 下多个账号。同步逻辑将每个启用的实例映射为一个 account 条目：

```typescript
// 以钉钉为例
const enabledDingTalkInstances = dingTalkInstances.filter(i => i.enabled && i.clientId);
if (enabledDingTalkInstances.length > 0) {
  const accounts: Record<string, unknown> = {};
  for (let idx = 0; idx < enabledDingTalkInstances.length; idx++) {
    const inst = enabledDingTalkInstances[idx];
    const secretVar = idx === 0
      ? 'LOBSTER_DINGTALK_CLIENT_SECRET'
      : `LOBSTER_DINGTALK_CLIENT_SECRET_${idx}`;
    accounts[inst.instanceId.slice(0, 8)] = buildDingTalkAccountConfig(inst, secretVar);
  }
  managedConfig.channels.dingtalk = { accounts };
}
```

**Account Key**：使用 `instanceId.slice(0, 8)`（UUID 前 8 位）作为 account 标识符。

### 5.3 环境变量

Secrets 通过环境变量注入，每个实例使用独立的变量名：

| 实例序号 | 钉钉 | 飞书 | QQ |
|----------|------|------|-----|
| 第 1 个 | `LOBSTER_DINGTALK_CLIENT_SECRET` | `LOBSTER_FEISHU_APP_SECRET` | `LOBSTER_QQ_CLIENT_SECRET` |
| 第 2 个 | `LOBSTER_DINGTALK_CLIENT_SECRET_1` | `LOBSTER_FEISHU_APP_SECRET_1` | `LOBSTER_QQ_CLIENT_SECRET_1` |
| 第 N 个 | `LOBSTER_DINGTALK_CLIENT_SECRET_N` | `LOBSTER_FEISHU_APP_SECRET_N` | `LOBSTER_QQ_CLIENT_SECRET_N` |

注意：序号基于 **启用实例** 的过滤结果，而非全部实例。`sync()` 和 `buildEnv()` 必须使用相同的过滤和排序逻辑。

### 5.4 Session Scope 变更

```typescript
session: {
  dmScope: 'per-account-channel-peer',  // 旧: 'per-channel-peer'
}
```

升级为 `per-account-channel-peer`，确保不同 account（即不同机器人实例）的会话相互隔离。

### 5.5 Session Key 解析

**文件**：`src/main/libs/openclawChannelSessionSync.ts`

新增对 `per-account-channel-peer` 格式的 session key 解析：

```
旧格式: agent:{agentId}:{channel}:{peerKind}:{peerId}
新格式: agent:{agentId}:{channel}:{accountId}:{peerKind}:{peerId}
```

通过检测 `parts[3]` 是否为已知 peer kind（`direct`、`group`、`channel`）来区分两种格式。如果不是已知 peer kind，则将其视为 `accountId`，并包含在 `conversationId` 中以实现不同账号的会话隔离。

### 5.6 Plugin 启用判断

```typescript
// 旧
if (id === 'dingtalk') return !!(dingTalkConfig?.enabled && dingTalkConfig.clientId);

// 新: 只要有任一启用实例，plugin 即启用
if (id === 'dingtalk') return dingTalkInstances.some(i => i.enabled && i.clientId);
```

---

## 6. IPC 通信层

### 6.1 新增 IPC Channels

**文件**：`src/main/main.ts`、`src/main/preload.ts`

每个多实例平台新增 3 个 IPC channel：

| Channel | 说明 |
|---------|------|
| `im:dingtalk:instance:add` | 创建钉钉实例（生成 UUID，应用默认配置） |
| `im:dingtalk:instance:delete` | 删除钉钉实例 |
| `im:dingtalk:instance:config:set` | 更新钉钉实例配置（支持 `syncGateway` 选项） |
| `im:feishu:instance:add` | 创建飞书实例 |
| `im:feishu:instance:delete` | 删除飞书实例 |
| `im:feishu:instance:config:set` | 更新飞书实例配置 |
| `im:qq:instance:add` | 创建 QQ 实例 |
| `im:qq:instance:delete` | 删除 QQ 实例 |
| `im:qq:instance:config:set` | 更新 QQ 实例配置 |

### 6.2 Preload API

```typescript
// src/main/preload.ts — 新增暴露的 API
window.electron.im.addDingTalkInstance(name: string)
window.electron.im.deleteDingTalkInstance(instanceId: string)
window.electron.im.setDingTalkInstanceConfig(instanceId, config, options?)
// ... 飞书、QQ 同理
```

### 6.3 `syncGateway` 选项

配置更新支持可选的 `syncGateway` 参数：
- `syncGateway: false` — 仅持久化配置，不触发网关同步（用于实时表单编辑）
- `syncGateway: true` — 持久化 + 触发 `scheduleImConfigSync()` 同步到 OpenClaw（用于保存按钮）

---

## 7. 前端 UI 变更

### 7.1 新增组件

三个平台各自拆分为独立的实例配置组件：

| 文件 | 说明 |
|------|------|
| `src/renderer/components/im/DingTalkInstanceSettings.tsx` | 钉钉单实例配置表单（572 行） |
| `src/renderer/components/im/FeishuInstanceSettings.tsx` | 飞书单实例配置表单（732 行） |
| `src/renderer/components/im/QQInstanceSettings.tsx` | QQ 单实例配置表单（457 行） |

每个组件包含：
- 实例名称编辑（可重命名）
- 凭证输入（AppID/AppSecret 等）
- 消息策略配置（DM/Group policy）
- 高级选项（debug 模式等）
- 连接状态显示
- 删除实例按钮（带确认）
- 启用/禁用开关

### 7.2 IMSettings 重构

**文件**：`src/renderer/components/im/IMSettings.tsx`

从 1494 行减少到约 500 行（-67%），主要变更：
- 钉钉、飞书、QQ 的内联配置代码抽取到独立组件
- 多实例管理逻辑：添加实例按钮、实例列表渲染、最大实例数限制
- Tab 切换显示各实例的配置面板

### 7.3 Redux Store 变更

**文件**：`src/renderer/store/slices/imSlice.ts`

新增 actions：

```typescript
// 钉钉
addDingTalkInstance(state, action: PayloadAction<DingTalkInstanceConfig>)
removeDingTalkInstance(state, action: PayloadAction<string>)  // instanceId
setDingTalkInstanceConfig(state, action: PayloadAction<{ instanceId, config }>)
setDingTalkInstances(state, action: PayloadAction<DingTalkInstanceConfig[]>)
setDingTalkMultiInstanceConfig(state, action: PayloadAction<DingTalkMultiInstanceConfig>)

// 飞书、QQ 同理
```

旧 actions（`setDingTalkConfig` 等）标记 `@deprecated`，保留向后兼容：更新第一个实例的配置。

### 7.4 IMService 变更

**文件**：`src/renderer/services/im.ts`

每个多实例平台新增 4 个方法：

```typescript
addDingTalkInstance(name: string): Promise<DingTalkInstanceConfig | null>
deleteDingTalkInstance(instanceId: string): Promise<boolean>
persistDingTalkInstanceConfig(instanceId, config): Promise<boolean>   // 仅持久化
updateDingTalkInstanceConfig(instanceId, config): Promise<boolean>    // 持久化 + 同步网关
```

### 7.5 国际化

**文件**：`src/renderer/services/i18n.ts`

新增 15 个 i18n key，覆盖三个平台的实例管理文本（中/英双语）：

```
imQQAddInstance / imQQClickToRename / imQQDeleteInstance / imQQEnableInstance / imQQDisableInstance
imFeishuAddInstance / imFeishuDeleteInstance / imFeishuDeleteConfirm / imFeishuInstanceName / imFeishuMaxInstances
imDingTalkAddInstance / imDingTalkDeleteInstance / imDingTalkDeleteConfirm / imDingTalkInstanceName / imDingTalkMaxInstances
```

---

## 8. 附加修复

### 8.1 QQ Bot 路由前缀清理

**文件**：`src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

`stripQQBotSystemPrompt()` 新增对 `[QQBot] to=qqbot:c2c:XXXX` 路由前缀的清理：

```typescript
const routingPrefixRe = /^\[QQBot\]\s*to=\S+\s*/;
if (routingPrefixRe.test(text)) {
  text = text.replace(routingPrefixRe, '').trim();
}
```

多实例场景下，QQBot plugin 会在消息前添加路由前缀以标识来源实例，需要在展示前移除。

---

## 9. 边缘场景（Edge Cases）

### 9.1 单实例到多实例迁移

**场景**：用户升级到新版本，已有单实例钉钉/飞书/QQ 配置。

**处理**：
- `ensureMigrations()` 自动检测旧 key 并迁移
- 迁移同时处理 `im_session_mappings`（platform 字段更新）和 `platformAgentBindings`（binding key 更新）
- 迁移是幂等的 — 已有 `{platform}:*` 记录时跳过

**风险**：迁移期间如果应用崩溃，可能导致部分迁移。但由于检查条件是"旧 key 存在 且 新 key 不存在"，重启后会重新尝试。

### 9.2 删除实例后的会话孤儿

**场景**：用户删除一个正在使用的机器人实例。

**处理**：
- `deleteInstance()` 同时删除 `im_session_mappings` 中关联的映射
- 已存在的 cowork sessions 不会被删除（仍可在 UI 中查看历史）
- 该实例的 IM 消息将不再被路由到任何 session

### 9.3 环境变量索引错位

**场景**：3 个实例中禁用中间的一个，环境变量索引可能不匹配。

**处理**：
- `sync()` 和 `buildEnv()` 均使用 `filter(i => i.enabled && ...)` 后的数组索引
- 两处过滤条件必须完全一致，否则 secret 会对应到错误的实例
- 当前实现中 `sync()` 过滤 `i.enabled && i.clientId`，`buildEnv()` 过滤 `i.enabled && i.clientSecret`，条件略有差异但实际上有效实例必然同时满足两个条件

### 9.4 Account ID 冲突

**场景**：两个实例的 UUID 前 8 位相同（概率极低，~1/4.3B）。

**处理**：当前使用 `instanceId.slice(0, 8)` 作为 OpenClaw account key。UUID v4 前 8 位碰撞概率极低，实际场景（最多 5 个实例）可忽略。如需规避可使用完整 UUID，但会降低配置文件可读性。

### 9.5 超过最大实例数

**场景**：用户尝试添加超过 5 个实例。

**处理**：
- 前端 UI 通过 `MAX_*_INSTANCES` 常量控制，达到上限后"添加实例"按钮禁用
- 后端 IPC handler 无硬性限制（信任前端检查）

### 9.6 旧版本 deprecated API 兼容

**场景**：代码中其他位置仍使用旧 API（如 `setDingTalkConfig`）。

**处理**：
- 旧 Redux actions 改为更新第一个实例的配置（backward compat shim）
- 旧 IMStore 方法保留但标记 `@deprecated`
- `setConfig()` 中 `config.dingtalk` 路由到 `setDingTalkMultiInstanceConfig()`

### 9.7 空实例列表

**场景**：用户删除所有实例后，配置为空数组。

**处理**：
- `getDingTalkMultiInstanceConfig()` 在实例为空时返回 `DEFAULT_DINGTALK_MULTI_INSTANCE_CONFIG`（`{ instances: [] }`）
- OpenClaw plugin 不会启用（`dingTalkInstances.some(i => i.enabled && i.clientId)` 返回 `false`）
- UI 中显示"Not configured"状态

---

## 10. 测试

### 10.1 自动化测试

**文件**：`tests/openclawConfigSync.test.mjs`

已更新测试用例以适配多实例接口：

```javascript
// 旧
const sync = createSync(tmpDir, appConfig, { qqConfig: { enabled: true, appId: '...' } });

// 新
const sync = createSync(tmpDir, appConfig, {
  qqInstances: [{
    instanceId: 'default',
    instanceName: 'Default',
    enabled: true,
    appId: 'qq-app-id',
    appSecret: 'qq-app-secret',
    // ...
  }],
});
```

**运行**：

```bash
npm test -- openclawConfigSync
```

### 10.2 手动测试矩阵

#### 多实例管理

| 测试项 | 步骤 | 预期结果 |
|--------|------|----------|
| 添加实例 | 在 IM 设置中点击"添加实例" | 新实例以默认配置出现在列表中 |
| 重命名实例 | 点击实例名称编辑 | 名称更新并持久化 |
| 删除实例 | 点击删除按钮并确认 | 实例从列表移除，关联数据清理 |
| 最大实例限制 | 添加 5 个实例后尝试继续添加 | "添加实例"按钮禁用，显示"已达最大实例数量" |
| 启用/禁用实例 | 切换实例启用开关 | 实例连接状态相应变化 |

#### 配置持久化

| 测试项 | 步骤 | 预期结果 |
|--------|------|----------|
| 凭证保存 | 输入 AppID/AppSecret 并保存 | 重启应用后配置仍在 |
| 多实例独立配置 | 两个实例配置不同的策略 | 各自策略独立生效 |
| 网关同步 | 保存配置并检查 OpenClaw config.yaml | 生成正确的 `accounts` 字典 |

#### 数据迁移

| 测试项 | 步骤 | 预期结果 |
|--------|------|----------|
| 旧版升级 | 使用旧版单实例配置启动新版 | 自动迁移为多实例，配置不丢失 |
| Session 映射迁移 | 迁移后检查 IM 会话 | 旧会话仍关联到迁移后的实例 |
| Agent 绑定迁移 | 迁移后检查 Agent 设置 | 旧 binding 更新为带 instanceId 的格式 |

#### 多实例协同

| 测试项 | 步骤 | 预期结果 |
|--------|------|----------|
| 同时运行两个机器人 | 启用两个钉钉实例 | 两个机器人同时在线接收消息 |
| 会话隔离 | 通过不同机器人发消息 | 各自产生独立的 cowork session |
| 独立状态 | 一个实例断开，另一个正常 | 状态面板正确显示各自状态 |

#### 多平台验证

| 平台 | 特殊验证点 |
|------|-----------|
| 钉钉 | `gatewayToken` 在多实例间共享（非 per-instance） |
| 飞书 | 域名（feishu/lark）和群组配置各实例独立 |
| QQ | `[QQBot] to=...` 路由前缀在多实例下被正确清理 |

---

## 11. 文件清单

| 文件 | 角色 | 变更类型 |
|------|------|----------|
| `src/main/im/types.ts` | 多实例类型定义 + 默认值 | 修改 |
| `src/main/im/imStore.ts` | 多实例 CRUD + 数据迁移 | 修改（+366 行） |
| `src/main/im/imGatewayManager.ts` | 状态结构适配多实例 | 修改 |
| `src/main/main.ts` | 新增 9 个 IPC handlers | 修改（+156 行） |
| `src/main/preload.ts` | 新增 preload API | 修改 |
| `src/main/libs/openclawConfigSync.ts` | 多实例 → accounts 同步 | 修改（+248 行重构） |
| `src/main/libs/openclawChannelSessionSync.ts` | per-account session key 解析 | 修改 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | QQ 路由前缀清理 | 修改 |
| `src/renderer/components/im/DingTalkInstanceSettings.tsx` | 钉钉实例配置 UI | 新增 |
| `src/renderer/components/im/FeishuInstanceSettings.tsx` | 飞书实例配置 UI | 新增 |
| `src/renderer/components/im/QQInstanceSettings.tsx` | QQ 实例配置 UI | 新增 |
| `src/renderer/components/im/IMSettings.tsx` | IM 设置页重构 | 修改（-1000 行） |
| `src/renderer/components/agent/AgentSettingsPanel.tsx` | 多实例 configured 判断 | 修改 |
| `src/renderer/services/im.ts` | 多实例 service 方法 | 修改（+200 行） |
| `src/renderer/services/i18n.ts` | 多实例 i18n 文本 | 修改 |
| `src/renderer/store/slices/imSlice.ts` | 多实例 Redux actions | 修改 |
| `src/renderer/types/im.ts` | 多实例渲染层类型 | 修改 |
| `src/renderer/types/electron.d.ts` | 多实例 IPC 类型声明 | 修改 |
| `tests/openclawConfigSync.test.mjs` | 测试适配多实例接口 | 修改 |
| `package.json` | 依赖更新 | 修改 |

---

## 12. 后续工作

本次变更完成了多实例的**配置管理**和**网关同步**。以下功能在后续 PR 中实现：

1. **Agent IM 多机器人绑定**（设计文档：`docs/superpowers/specs/2026-04-01-agent-im-multi-bot-binding-design.md`）
   - `platformAgentBindings` key 格式从 `'dingtalk'` 升级为 `'dingtalk:<instanceId>'`
   - Agent 设置面板显示分组布局，支持独立绑定各实例到不同 Agent
   - `imCoworkHandler.ts` 消息路由支持实例级别的 Agent 分发
