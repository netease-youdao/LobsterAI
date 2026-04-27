# Telegram Multi-Instance Support

**Date**: 2026-04-22
**Status**: Approved
**Scope**: Upgrade Telegram from single-bot to multi-instance (up to 5 bots)

## Background

Telegram is the only IM platform still using a singleton configuration model. All other platforms (DingTalk, Feishu, QQ, WeCom, NIM) already support multi-instance with a well-established pattern. This spec upgrades Telegram to follow the same architecture.

## Design

### 1. Type System

Add to both `src/main/im/types.ts` and `src/renderer/types/im.ts`:

```typescript
export const MAX_TELEGRAM_INSTANCES = 5;

export interface TelegramInstanceConfig extends TelegramOpenClawConfig {
  instanceId: string;   // UUID
  instanceName: string; // Display name, e.g. "Telegram Bot 1"
}

export interface TelegramInstanceStatus extends TelegramGatewayStatus {
  instanceId: string;
  instanceName: string;
}

export interface TelegramMultiInstanceConfig {
  instances: TelegramInstanceConfig[];
}

export interface TelegramMultiInstanceStatus {
  instances: TelegramInstanceStatus[];
}

export const DEFAULT_TELEGRAM_MULTI_INSTANCE_CONFIG: TelegramMultiInstanceConfig = {
  instances: [],
};
```

**Breaking changes to `IMGatewayConfig`:**
- `telegram: TelegramOpenClawConfig` -> `telegram: TelegramMultiInstanceConfig`

**Breaking changes to `IMGatewayStatus`:**
- `telegram: TelegramGatewayStatus` -> `telegram: TelegramMultiInstanceStatus`

Update `DEFAULT_IM_CONFIG.telegram` to `DEFAULT_TELEGRAM_MULTI_INSTANCE_CONFIG`.
Update `DEFAULT_IM_STATUS.telegram` to `{ instances: [] }`.

### 2. Storage Layer (`src/main/im/imStore.ts`)

Add CRUD methods following the existing Feishu/DingTalk pattern:

- `getTelegramInstances(): TelegramInstanceConfig[]` - scan `im_config` for keys matching `telegram:%`
- `getTelegramInstanceConfig(instanceId: string): TelegramInstanceConfig | null`
- `setTelegramInstanceConfig(instanceId: string, config: TelegramInstanceConfig): void` - upsert under key `telegram:<instanceId>`
- `deleteTelegramInstance(instanceId: string): void` - delete config key + cascade delete `im_session_mappings` where `platform LIKE 'telegram:<instanceId>%'`
- `getTelegramMultiInstanceConfig(): TelegramMultiInstanceConfig`
- `setTelegramMultiInstanceConfig(config: TelegramMultiInstanceConfig): void`

### 3. Data Migration (`imStore.migrateDefaults()`)

Automatic migration on app startup:

1. Read old `telegramOpenClaw` key from `im_config` table
2. If present, generate a new UUID and create key `telegram:<uuid>` with the old config + `instanceId: uuid, instanceName: 'Telegram Bot 1'`
3. Re-key `platformAgentBindings.telegram` -> `platformAgentBindings['telegram:<uuid>']` in `im_settings`
4. Re-key `im_session_mappings` where `platform = 'telegram'` -> `platform = 'telegram:<uuid>'`
5. Delete old `telegramOpenClaw` key

This matches the migration already used for DingTalk (`dingtalkOpenClaw` -> `dingtalk:<uuid>`) and Feishu (`feishuOpenClaw` -> `feishu:<uuid>`).

### 4. OpenClaw Config Sync (`src/main/libs/openclawConfigSync.ts`)

Change Telegram section from flat config to multi-account dict:

```typescript
// Before:
managedConfig.channels.telegram = { enabled: true, botToken: '${LOBSTER_TG_BOT_TOKEN}', ... };

// After:
const accounts: Record<string, unknown> = {};
for (let idx = 0; idx < enabledTelegramInstances.length; idx++) {
  const inst = enabledTelegramInstances[idx];
  const tokenVar = idx === 0 ? 'LOBSTER_TG_BOT_TOKEN' : `LOBSTER_TG_BOT_TOKEN_${idx}`;
  const webhookSecretVar = idx === 0 ? 'LOBSTER_TG_WEBHOOK_SECRET' : `LOBSTER_TG_WEBHOOK_SECRET_${idx}`;
  accounts[inst.instanceId.slice(0, 8)] = {
    enabled: true,
    botToken: `\${${tokenVar}}`,
    // ... all other config fields
    webhookSecret: inst.webhookSecret ? `\${${webhookSecretVar}}` : undefined,
  };
}
managedConfig.channels.telegram = { enabled: true, accounts };
```

Environment variables:
- Bot tokens: `LOBSTER_TG_BOT_TOKEN`, `LOBSTER_TG_BOT_TOKEN_1`, ..., `LOBSTER_TG_BOT_TOKEN_N`
- Webhook secrets: `LOBSTER_TG_WEBHOOK_SECRET`, `LOBSTER_TG_WEBHOOK_SECRET_1`, ..., `LOBSTER_TG_WEBHOOK_SECRET_N`

Add `'telegram'` to `MULTI_INSTANCE_CONFIG_KEYS` set.

### 5. IPC Channels

New channels registered in `src/main/main.ts`, exposed in `src/main/preload.ts`:

| Channel | Parameters | Returns | Purpose |
|---------|-----------|---------|---------|
| `im:telegram:instance:add` | `name: string` | `{ success, instance }` | Create new instance with UUID |
| `im:telegram:instance:delete` | `instanceId: string` | `{ success }` | Delete instance + trigger config sync |
| `im:telegram:instance:config:set` | `instanceId, config, { syncGateway? }` | `{ success }` | Update instance config |

### 6. UI Components

#### New: `src/renderer/components/im/TelegramInstanceSettings.tsx`

Extract from inline Telegram code in `IMSettings.tsx`. Props interface:

```typescript
interface TelegramInstanceSettingsProps {
  instance: TelegramInstanceConfig;
  instanceStatus: TelegramInstanceStatus | undefined;
  onConfigChange: (update: Partial<TelegramOpenClawConfig>) => void;
  onSave: (override?: Partial<TelegramOpenClawConfig>) => Promise<void>;
  onRename: (newName: string) => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onTestConnectivity: () => void;
  testingPlatform: string | null;
  connectivityResults: Record<string, IMConnectivityTestResult>;
  language: 'zh' | 'en';
}
```

Fields:
- Bot Token (password input with show/hide)
- Enable/disable toggle (disabled unless botToken is filled)
- Connection status badge (green/gray)
- Connectivity test button
- Inline rename (click-to-edit instance name)
- Delete button
- Advanced settings (collapsible): DM Policy, Allow From, Group Policy, Group Allow From, Streaming, Proxy, Reply-to Mode, History Limit, Media Max MB, Link Preview, Webhook URL, Webhook Secret, Debug

#### Modified: `src/renderer/components/im/IMSettings.tsx`

Replace inline Telegram section with multi-instance accordion:
- State: `telegramExpanded`, `activeTelegramInstanceId`
- Instance list with clickable items showing name + status badge
- "Add Telegram Bot" button (hidden when `instances.length >= MAX_TELEGRAM_INSTANCES`)
- Delegates per-instance rendering to `TelegramInstanceSettings`

### 7. Agent Binding (`src/renderer/components/agent/AgentSettingsPanel.tsx`)

Add `'telegram'` to `MULTI_INSTANCE_PLATFORMS` array. Each Telegram instance appears as a bindable toggle item with format `telegram:<instanceId>`.

### 8. Scheduled Tasks (`src/main/ipcHandlers/scheduledTask/helpers.ts`)

Update `listScheduledTaskChannels()`:
- Read `telegramInstances` from `imStore.getTelegramInstances()`
- Filter enabled instances with `botToken`
- Emit one channel option per instance: `{ value: 'telegram', label: 'Telegram - <name>', accountId: instanceId.slice(0, 8), filterAccountId: instanceId.slice(0, 8) }`

### 9. Gateway Manager (`src/main/im/imGatewayManager.ts`)

- `getStatus()`: Return `TelegramMultiInstanceStatus` with per-instance status objects. Each instance's `connected` is determined by `inst.enabled && inst.botToken`.
- `isConnected('telegram')`: Return `true` if any instance is enabled and has a botToken.
- `testConnectivity('telegram', instanceId?)`: Accept optional instanceId for per-instance testing, falling back to testing all instances.

### 10. Redux Slice (`src/renderer/store/slices/imSlice.ts`)

Replace `setTelegramOpenClawConfig` reducer with:
- Config now stored as `TelegramMultiInstanceConfig` (array of instances)
- Instance-level updates dispatched from `TelegramInstanceSettings`

### 11. Renderer Service (`src/renderer/services/im.ts`)

Add methods:
- `addTelegramInstance(name: string): Promise<TelegramInstanceConfig>`
- `deleteTelegramInstance(instanceId: string): Promise<void>`
- `persistTelegramInstanceConfig(instanceId: string, config: Partial<TelegramOpenClawConfig>, opts?): Promise<void>`
- `updateTelegramInstanceConfig(instanceId: string, update: Partial<TelegramOpenClawConfig>): void` (local state only)

### 12. Preload (`src/main/preload.ts`)

Add to `window.electron.im` namespace:
- `addTelegramInstance(name: string)`
- `deleteTelegramInstance(instanceId: string)`
- `setTelegramInstanceConfig(instanceId: string, config: Partial<TelegramOpenClawConfig>, opts?: { syncGateway?: boolean })`

### 13. Session Sync (`src/main/libs/openclawChannelSessionSync.ts`)

Ensure `resolveAgentBinding()` handles `telegram` prefix the same as `dingtalk`/`feishu` — matching accountId (first 8 chars) to instance UUID for correct agent binding resolution.

## Files Changed

| File | Change |
|------|--------|
| `src/main/im/types.ts` | Add Telegram multi-instance types, update `IMGatewayConfig`/`IMGatewayStatus` |
| `src/renderer/types/im.ts` | Mirror type changes |
| `src/main/im/imStore.ts` | Add Telegram CRUD methods, migration logic |
| `src/main/libs/openclawConfigSync.ts` | Telegram accounts dict, env var injection |
| `src/main/main.ts` | Register 3 new IPC handlers |
| `src/main/preload.ts` | Expose new IPC bridges |
| `src/renderer/types/electron.d.ts` | Type declarations for new preload APIs |
| `src/renderer/components/im/TelegramInstanceSettings.tsx` | **New** — per-instance settings form |
| `src/renderer/components/im/IMSettings.tsx` | Replace inline Telegram with multi-instance accordion |
| `src/renderer/components/agent/AgentSettingsPanel.tsx` | Add `'telegram'` to `MULTI_INSTANCE_PLATFORMS` |
| `src/main/ipcHandlers/scheduledTask/helpers.ts` | Per-instance channel options |
| `src/main/im/imGatewayManager.ts` | Multi-instance status, connectivity |
| `src/renderer/store/slices/imSlice.ts` | Instance-aware reducers |
| `src/renderer/services/im.ts` | Add instance CRUD service methods |
| `src/main/libs/openclawChannelSessionSync.ts` | Handle telegram prefix in agent binding |

## Not In Scope

- QR code or automated bot creation (Telegram uses manual BotFather flow)
- Telegram Bot API verify endpoint (optional future enhancement)
- Changes to other IM platforms
