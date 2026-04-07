# LobsterAI ToB Enterprise Config Support

## Overview

Enable LobsterAI to support enterprise (ToB) deployment by reading a pre-configured package on startup, syncing model/IM/skill/agent/MCP configurations into SQLite, and locking down the UI so users can work immediately without manual setup.

**Core principle**: Inject enterprise data into SQLite tables before the normal initialization flow. The existing `kv → openclawConfigSync → openclaw.json` pipeline remains untouched.

## Enterprise Config Package Structure

```
enterprise-config/                     # Fixed path: {userData}/enterprise-config/
├── manifest.json                      # Metadata + UI customization rules
├── app_config.json                    # Model/provider config (direct kv['app_config'] format)
├── openclaw.json                      # IM channels + cowork config (same structure as generated)
├── skills/                            # Pre-installed skills (optional)
│   ├── skill-a/
│   │   └── SKILL.md
│   └── skill-b/
│       └── SKILL.md
├── agents/                            # Agent config files (optional)
│   ├── IDENTITY.md
│   ├── SOUL.md
│   └── USER.md
└── mcp/                              # MCP service configs (optional)
    └── servers.json                   # MCP server list
```

**Detection**: `{userData}/enterprise-config/manifest.json` exists → enterprise mode active.

**Platform paths**:
- macOS: `~/Library/Application Support/LobsterAI/enterprise-config/`
- Windows: `%APPDATA%/LobsterAI/enterprise-config/`

**Update strategy**: Replace config package files, restart app. Every startup re-syncs from the package.

## manifest.json

```json
{
  "version": "1.0.0",
  "name": "Enterprise Standard Config",
  "ui": {
    "hideTabs": ["settings.im", "settings.model"],
    "disableUpdate": true
  },
  "sync": {
    "openclaw": true,
    "skills": true,
    "agents": true,
    "mcp": true
  }
}
```

- `ui.hideTabs`: Settings tabs to hide. Format: `settings.<tabKey>`. Supported keys: `im`, `model`, `general`, `coworkAgentEngine`, `email`, `mcp`, `about`.
- `ui.disableUpdate`: Block in-app update checks and downloads.
- `sync.*`: Toggle which parts of the config package are synced. Missing directories are silently skipped.

## Configuration Mapping

### Model/Provider Config → `kv['app_config']`

Model configuration uses a **separate `app_config.json`** file (not derived from openclaw.json) to avoid lossy reverse-mapping. The `openclawConfigSync` forward path collapses many providers into `providerId: 'lobster'`, making reverse mapping ambiguous.

`app_config.json` uses the exact same structure as the `kv['app_config']` value in SQLite — it is written directly without transformation.

```json
{
  "api": { "key": "sk-xxx", "baseUrl": "https://api.deepseek.com/anthropic" },
  "model": {
    "availableModels": [
      { "id": "deepseek-reasoner", "name": "DeepSeek Reasoner", "supportsImage": false }
    ],
    "defaultModel": "deepseek-reasoner",
    "defaultModelProvider": "deepseek"
  },
  "providers": {
    "deepseek": {
      "enabled": true,
      "apiKey": "sk-xxx",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiFormat": "anthropic",
      "models": [
        { "id": "deepseek-reasoner", "name": "DeepSeek Reasoner", "supportsImage": false }
      ]
    }
  },
  "theme": "system",
  "language": "zh",
  "useSystemProxy": false
}
```

Key fields:
- `providers[key].enabled`: Must be `true` for providers to be active
- `providers[key].codingPlanEnabled`: Optional, for moonshot/zhipu/qwen/volcengine coding endpoints
- `model.defaultModel` + `model.defaultModelProvider`: Determines the default selected model

### openclaw.json → SQLite Mapping

The enterprise `openclaw.json` uses the same structure that `openclawConfigSync` generates. It provides **IM channel configs and cowork settings** (model config comes from `app_config.json` instead).

### IM Channels → `im_config` table

```
openclaw.json channels key             →  im_config table key
─────────────────────────────────────────────────────────
channels.telegram                      →  telegramOpenClaw
channels.discord                       →  discordOpenClaw
channels.feishu                        →  feishuOpenClaw
channels["dingtalk-connector"]         →  dingtalkOpenClaw
channels.qqbot                         →  qq
channels.wecom                         →  wecomOpenClaw
channels["moltbot-popo"]               →  popo
channels.nim                           →  nim
channels["openclaw-weixin"]            →  weixin
channels.xiaomifeng                    →  xiaomifeng
```

Each channel's fields map to the corresponding platform config type (e.g., `TelegramOpenClawConfig`, `DingTalkOpenClawConfig`). Field name conversion is needed between openclaw.json format and internal type format. Enterprise `openclaw.json` should use plain text for secrets (not `${VARIABLE}` placeholders).

### Cowork Config → `cowork_config` table

```
openclaw.json                          →  cowork_config key
─────────────────────────────────────────────────────────
agents.defaults.sandbox.mode           →  executionMode (off→local, non-main→auto, all→sandbox)
agents.defaults.workspace              →  workingDirectory
(fixed)                                →  agentEngine = 'openclaw'
```

### MCP Servers → `mcp_servers` table

Read from `mcp/servers.json` (separate from openclaw.json), format matches `McpServerFormData`:

```json
[
  {
    "name": "example-mcp",
    "description": "Enterprise tool",
    "enabled": true,
    "transportType": "stdio",
    "command": "node",
    "args": ["server.js"],
    "env": {}
  }
]
```

### Other kv entries

```
Source                                 →  kv key
─────────────────────────────────────────────────────────
manifest.json (full content)           →  enterprise_config
manifest.autoAcceptPrivacy (if true)   →  privacy_agreed = true
```

## Conflict Resolution Strategy

Enterprise config uses **full overwrite on every startup**:
- `kv['app_config']`: Replaced entirely with `app_config.json` content
- `im_config` table: Each platform key overwritten with enterprise values
- `cowork_config` table: Enterprise keys overwritten
- `mcp_servers` table: Enterprise MCP servers upserted by name (user-added servers preserved)
- `SKILLs/` directory: Enterprise skills overwrite same-name directories (user-added skills preserved)
- Agent `.md` files: Overwritten each startup

This ensures enterprise config cannot be tampered with, and updates take effect on next restart.

## File Sync

### Skills

When `sync.skills` is true:
- Copy `enterprise-config/skills/*` → `{userData}/SKILLs/`
- Overwrite existing skills with same name (user-added skills preserved)
- Set enterprise skills to `enabled: true` in `skills_state` (`Record<string, { enabled: boolean }>` keyed by skill directory name)

### Agents

When `sync.agents` is true:
- Copy `enterprise-config/agents/*.md` → OpenClaw workspace directory (resolved from `cowork_config.workingDirectory`, default `~/.openclaw/workspace/`)
- Files: `IDENTITY.md`, `SOUL.md`, `USER.md`
- Only copy files that exist in the package

## Startup Integration

```
app.whenReady()
  → initStore()                              // existing
  → resolveEnterpriseConfigPath()            // NEW: detect enterprise-config/
  → if found:
      syncEnterpriseConfig(store, imStore, mcpStore, coworkStore)  // NEW
        1. Read + parse manifest.json
        2. Write kv['enterprise_config'] = manifest
        3. If manifest.autoAcceptPrivacy: write kv['privacy_agreed'] = true
        4. if sync.openclaw:
           a. Read app_config.json → write kv['app_config'] directly
           b. Parse openclaw.json channels.* → write im_config keys
           c. Parse openclaw.json agents.defaults → write cowork_config keys
        5. if sync.skills:
           a. Copy skills/ → {userData}/SKILLs/
           b. Update skills_state
        6. if sync.agents:
           a. Copy agents/*.md → workspace directory
        7. if sync.mcp:
           a. Parse mcp/servers.json → write mcp_servers table
  → Normal init (skillManager, openclawConfigSync, ...)  // UNCHANGED
  → Create BrowserWindow
  → Renderer reads enterprise_config → apply UI customization
```

## UI Customization

### Hide Settings Tabs (Renderer)

`Settings.tsx` → `sidebarTabs` filtered by `hideTabs`:

```typescript
const enterpriseConfig = useEnterpriseConfig(); // from IPC
const hideTabs = (enterpriseConfig?.ui?.hideTabs ?? [])
  .map(t => t.replace('settings.', ''));
const filteredTabs = allTabs.filter(tab => !hideTabs.includes(tab.key));
```

### Disable Updates

**Renderer** (`Settings.tsx` about tab):
- Hide update button when `disableUpdate` is true
- Show "Managed by enterprise" label

**Main process** (`main.ts`):
- `appUpdate:download` IPC handler rejects when enterprise mode active

### New IPC Channel

```
ipcMain.handle('enterprise:getConfig')  → returns kv['enterprise_config'] value or null
```

Exposed via preload: `window.electron.enterprise.getConfig()`

## New Module

### `src/main/libs/enterpriseConfigSync.ts`

```typescript
export function resolveEnterpriseConfigPath(): string | null
export async function syncEnterpriseConfig(
  store: SqliteStore,
  imStore: IMStore,
  mcpStore: McpStore,
  coworkStore: CoworkStore
): Promise<EnterpriseConfig | null>

export type EnterpriseConfig = {
  version: string;
  name: string;
  ui: { hideTabs: string[]; disableUpdate: boolean };
  sync: { openclaw: boolean; skills: boolean; agents: boolean; mcp: boolean };
  autoAcceptPrivacy?: boolean;
}
```

## Files Changed

### New

| File | Purpose |
|------|---------|
| `src/main/libs/enterpriseConfigSync.ts` | Core: detect, parse, sync enterprise config |

### Modified

| File | Change |
|------|--------|
| `src/main/main.ts` | Call `syncEnterpriseConfig()` in startup; add `enterprise:getConfig` IPC; intercept `appUpdate:download` |
| `src/main/preload.ts` | Expose `enterprise.getConfig` |
| `src/renderer/App.tsx` | Fetch enterprise config on init, pass to components |
| `src/renderer/components/Settings.tsx` | Filter tabs by `hideTabs`; hide update button when `disableUpdate` |

### Unchanged

| File | Reason |
|------|--------|
| `openclawConfigSync.ts` | Reads from SQLite as before |
| `claudeSettings.ts` | Reads kv['app_config'] as before |
| `imStore.ts` / `imGatewayManager.ts` | Read from im_config as before |
| `skillManager.ts` | Scans SKILLs/ directory as before |
| `mcpStore.ts` | Reads mcp_servers table as before |
| `coworkStore.ts` | Reads cowork_config as before |

## i18n Keys

Main process (`src/main/i18n.ts`):
- `enterprise.updateBlocked`: "Updates are managed by enterprise" / "版本更新由企业统一管理"

Renderer (`src/renderer/services/i18n.ts`):
- `settings.enterprise.managed`: "Managed by enterprise" / "由企业统一管理"

## Error Handling

- `manifest.json` parse failure → skip enterprise config, start normally, log error
- `app_config.json` parse failure → skip model sync, continue others
- `openclaw.json` parse failure → skip IM/cowork sync, continue others
- File copy failure → log warning, don't block startup
- Missing optional files/directories (app_config.json, openclaw.json, skills/, agents/, mcp/) → skip silently

## Testing

- `enterpriseConfigSync.test.ts`: Unit tests for manifest parsing, openclaw.json mapping, file copy logic
- Manual: place enterprise config package → start app → verify IM/model configs applied → confirm tabs hidden → confirm update blocked
