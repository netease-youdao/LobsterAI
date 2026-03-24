# Enterprise Config Import via CLI

## Overview

LobsterAI needs enterprise batch deployment support: IT/ops teams push a unified config file to multiple machines, and LobsterAI loads it on startup. The config file reuses OpenClaw's `openclaw.json` format so that ops teams maintain a single config for both OpenClaw and LobsterAI deployments.

## Usage

```bash
lobsterai --config /opt/lobsterai/enterprise.json
```

On every startup with `--config`, the specified file is parsed and its contents are **force-written** into the local database, overriding any user changes made through the UI. Fields present in the config file are marked as "managed" and become read-only in the UI.

## Architecture

### Data Flow

```
Startup: lobsterai --config /path/to/config.json
  │
  ├─ cliArgs.ts: parse --config path from process.argv
  │
  ├─ configImporter.ts: read file + map fields
  │   ├─ models.providers  →  api-config.json
  │   ├─ channels.*        →  im_config table
  │   ├─ agents.defaults   →  cowork_config table
  │   └─ record managed_fields → kv table
  │
  ├─ Normal startup (create window, etc.)
  │
  └─ If agentEngine=openclaw:
      └─ openclawConfigSync syncs back to openclaw.json (existing logic)

Runtime:
  Settings UI ← config:getManagedFields → managed fields disabled
  UI write request → IPC handler checks managed_fields → reject/allow
```

### New Files

- `src/main/libs/cliArgs.ts` — Parse `process.argv`, extract `--config` path.
- `src/main/libs/configImporter.ts` — Core import logic: openclaw.json → internal storage field mapping.

### Modified Files

- `src/main/main.ts` — Call configImporter after `app.whenReady()`, add `config:getManagedFields` IPC handler.
- `src/main/main.ts` (IPC handlers) — `cowork:config:set`, `im:config:set`, `save-api-config` add managed_fields write interception.
- `src/main/preload.ts` — Expose `config:getManagedFields` via `contextBridge` so renderer can access it.
- `src/main/sqliteStore.ts` — Add managed_fields read/write helpers (or reuse kv table).
- `src/renderer/store/slices/coworkSlice.ts` (or new configSlice) — Store managedFields state.
- `src/renderer/components/` settings components — Managed badge UI, field disabling.
- `src/main/i18n.ts` + `src/renderer/services/i18n.ts` — Add managed-field i18n strings.

### Unchanged

- `openclawConfigSync.ts` — Forward sync logic stays the same.
- `coworkStore.ts` — Session/message storage not involved.
- `SKILLs/` — Skill system not involved.

## Config File Format

Reuses OpenClaw's `openclaw.json` structure. Example:

```json
{
  "models": {
    "providers": {
      "lobster": {
        "baseUrl": "https://api.example.com",
        "api": "anthropic-messages",
        "apiKey": "sk-xxx",
        "models": [{ "id": "claude-3-5-sonnet" }]
      }
    }
  },
  "agents": {
    "defaults": {
      "workspace": "/home/user/projects",
      "sandbox": { "mode": "off" }
    }
  },
  "channels": {
    "feishu": {
      "appId": "cli-xxx",
      "appSecret": "secret-xxx",
      "domain": "feishu"
    },
    "telegram": {
      "token": "bot-token-xxx"
    },
    "dingtalk-connector": {
      "clientId": "xxx",
      "clientSecret": "xxx"
    }
  }
}
```

Both OpenClaw plugin-style keys (`dingtalk-connector`, `qqbot`, `moltbot-popo`, `openclaw-weixin`) and short keys (`dingtalk`, `qq`, `popo`, `wechat`) are accepted. See the Channel Key Mapping table below for the full list.

## Field Mapping

### LLM API Config

Provider resolution: if config has multiple providers, use the one named `lobster`; if no `lobster` key, use the first provider.

```
openclaw.json                            →  api-config.json
───────────────────────────────────────────────────────────
models.providers.<name>.baseUrl          →  baseURL
models.providers.<name>.apiKey           →  apiKey
models.providers.<name>.api              →  apiType
                                            "anthropic-messages" → "anthropic"
                                            "openai-completions" → "openai"
models.providers.<name>.models[0].id     →  model
```

### Cowork Config

```
openclaw.json                            →  cowork_config table
───────────────────────────────────────────────────────────
agents.defaults.workspace                →  workingDirectory
agents.defaults.sandbox.mode             →  executionMode
                                            "off"      → "local"
                                            "all"      → "sandbox"
                                            "non-main" → "auto"
```

Note: the existing forward sync (`openclawConfigSync.ts`) currently hardcodes sandbox mode to `"off"`. If the enterprise config sets a different mode, the imported value will be stored correctly in the local database, but when the OpenClaw engine is active, the forward sync will override it back to `"off"` in `openclaw.json`. This is acceptable for the first version — sandbox mode control for OpenClaw can be addressed separately.

### IM Config

#### Channel Key Mapping

OpenClaw uses plugin-style channel keys that differ from LobsterAI's internal platform names. The importer accepts **both** forms for flexibility:

| openclaw.json channel key | LobsterAI im_config key |
|---------------------------|------------------------|
| `feishu` or `feishu-openclaw-plugin` | `feishu` |
| `telegram` | `telegram` |
| `discord` | `discord` |
| `dingtalk` or `dingtalk-connector` | `dingtalk` |
| `qq` or `qqbot` | `qq` |
| `wecom` | `wecom` |
| `popo` or `moltbot-popo` | `popo` |
| `wechat` or `openclaw-weixin` | `wechat` |
| `nim` | `nim` |
| `xiaomifeng` | `xiaomifeng` |

#### IM Field-Level Mapping

Most IM fields are identical between openclaw.json and internal storage. The following exceptions require transformation:

| Platform | openclaw.json field | im_config field |
|----------|-------------------|-----------------|
| Telegram | `token` | `botToken` |
| Discord | `token` | `botToken` |

All other IM fields (e.g., Feishu `appId`/`appSecret`, DingTalk `clientId`/`clientSecret`, POPO `appKey`/`appSecret`, etc.) are passed through as-is.

Each imported IM platform gets `enabled: true` automatically.

## Managed Fields

Stored in the `kv` table under key `managed_fields`:

```json
{
  "api": ["apiKey", "baseURL", "model", "apiType"],
  "cowork": ["workingDirectory"],
  "im": {
    "feishu": ["appId", "appSecret"],
    "telegram": ["botToken"]
  }
}
```

Only fields **actually present** in the config file are marked as managed. Missing fields are not marked and not overwritten.

## UI Behavior

### Managed Field Display

- Managed input fields are **disabled** (greyed out).
- A lock badge is shown next to managed fields: "Managed by organization".
- Tooltip: "This setting is managed by your organization. Contact your admin to change it."

### Write Interception

IPC handlers (`cowork:config:set`, `im:config:set`, `save-api-config`) check `managed_fields` before writing. If a field is managed, return `{ success: false, code: 'FIELD_MANAGED' }`.

### i18n Keys

```
zh: '由企业统一管理'       / en: 'Managed by organization'
zh: '此配置由企业统一管理，如需修改请联系管理员'
en: 'This setting is managed by your organization. Contact your admin to change it.'
```

## Error Handling

| Scenario | Behavior | Log Level |
|----------|----------|-----------|
| `--config` file does not exist | Skip import, start normally | `warn` |
| JSON parse failure | Skip import, start normally | `error` |
| Invalid field value (e.g., unknown apiType) | Skip that field, import rest | `warn` |
| File permission denied | Skip import, start normally | `error` |
| Unrecognized IM platform (e.g., `channels.slack`) | Ignore that platform, import rest | `warn` |

**Core principle**: Config import failure **never blocks startup**. Enterprise config is an enhancement, not a requirement.

**Validation approach**: Lenient parsing — recognized fields are extracted and used, unrecognized fields are silently ignored. OpenClaw-specific fields (e.g., `runtime` config) do not cause errors.

### Startup Logging

```
[ConfigImporter] loading enterprise config from /opt/lobsterai/enterprise.json
[ConfigImporter] imported API config: baseURL, apiKey, model, apiType
[ConfigImporter] imported IM config: feishu (appId, appSecret), telegram (botToken)
[ConfigImporter] imported cowork config: workingDirectory
[ConfigImporter] managed fields updated: 9 fields across 3 categories
```
