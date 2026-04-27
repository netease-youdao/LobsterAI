# OpenClaw Session Policy Setting — Design

## Overview

Add a simple user-facing setting in LobsterAI to control how long a conversation keeps its existing context before automatically starting a new session.

The goal is to expose one clear product concept while keeping OpenClaw's lower-level session policy details internal.

## Problem

LobsterAI currently writes only `session.dmScope` into runtime `openclaw.json`, while QClaw also configures `session.reset` and `session.maintenance`.

This creates two product issues:

- Users cannot control when old context should roll over into a new session.
- Session lifecycle behavior is not explicit in LobsterAI and depends more on OpenClaw defaults than intended.

At the same time, exposing raw OpenClaw fields such as `dmScope`, `idleMinutes`, `pruneAfter`, or `rotateBytes` would be too technical for most users.

## Design

### Product Model

Expose one global setting only:

- `会话保持时长`

Help text:

- `在这个时间内继续聊天，会沿用原来的上下文；超过后会自动开始新会话。时间越长，连续性更强，但也更容易带入较早的信息。`

Available options:

- `始终延续`
- `24小时`
- `7天（推荐）`
- `30天`
- `1年`

Default value:

- `7天`

### What This Setting Means

This setting controls when an inactive conversation should be treated as a new session.

- Shorter durations keep context fresher and reduce carry-over from older messages.
- Longer durations preserve continuity for long-running projects and assistant relationships.

The setting does not expose storage retention or low-level session key behavior to users.

### Internal Mapping

User-facing values map to OpenClaw `session.reset` as follows:

| User option | `session.reset.mode` | `session.reset.idleMinutes` |
|-------------|----------------------|-----------------------------|
| `始终延续` | `off` | omitted |
| `24小时` | `idle` | `1440` |
| `7天` | `idle` | `10080` |
| `30天` | `idle` | `43200` |
| `1年` | `idle` | `525600` |

### Internal Defaults Kept Out of UI

The following values remain app-managed and are not user-configurable in v1:

- `session.dmScope = per-account-channel-peer`
- `session.maintenance.pruneAfter = 365d`
- `session.maintenance.maxEntries = 1000000`
- `session.maintenance.rotateBytes = 1gb`

Rationale:

- `dmScope` affects session identity and historical session partitioning, so changing it is too risky for a simple user setting.
- `maintenance.*` is primarily storage governance, not a user-facing conversational preference.
- Keeping these internal makes the UI easier to understand and gives LobsterAI freedom to tune defaults later.

### Scope

This setting is global for v1.

- It applies to both desktop cowork sessions and IM channel sessions.
- No IM-specific override is added in v1.
- No per-agent or per-channel override is added in v1.

This keeps the mental model simple: one app-wide session continuity preference.

## Data Model

Add a dedicated OpenClaw session policy config rather than mixing this into existing cowork or IM settings.

```ts
export const OpenClawSessionKeepAlive = {
  Always: 'always',
  OneDay: '1d',
  SevenDays: '7d',
  ThirtyDays: '30d',
  OneYear: '365d',
} as const;

export type OpenClawSessionKeepAlive =
  typeof OpenClawSessionKeepAlive[keyof typeof OpenClawSessionKeepAlive];

export interface OpenClawSessionPolicyConfig {
  keepAlive: OpenClawSessionKeepAlive;
}
```

Why a dedicated config:

- It matches the actual owner of the behavior: generated OpenClaw runtime config.
- It avoids overloading `cowork_config` with IM-adjacent behavior.
- It leaves room for future expansion without polluting unrelated settings.

## Runtime Generation

`openclawConfigSync.ts` should always generate explicit `session.reset` and `session.maintenance` fields.

Target runtime shape:

```json
{
  "session": {
    "dmScope": "per-account-channel-peer",
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    },
    "maintenance": {
      "pruneAfter": "365d",
      "maxEntries": 1000000,
      "rotateBytes": "1gb"
    }
  }
}
```

If `keepAlive = always`, generate:

```json
{
  "session": {
    "dmScope": "per-account-channel-peer",
    "reset": {
      "mode": "off"
    },
    "maintenance": {
      "pruneAfter": "365d",
      "maxEntries": 1000000,
      "rotateBytes": "1gb"
    }
  }
}
```

## UI Placement

Place the setting in the main app settings area where users already configure AI behavior.

Recommended placement:

- OpenClaw or Cowork settings section
- Single select field or radio group
- Helper text directly below the field

Do not place it inside IM-only settings in v1, since the behavior is global.

## Migration and Compatibility

- Existing users who have no stored value receive the default `7天`.
- Existing `dmScope` stays unchanged as `per-account-channel-peer`.
- Legacy per-channel fields such as DingTalk `sessionTimeout` are not exposed in the new UI and should gradually become secondary to global `session.reset`.

## Non-Goals

Not included in v1:

- User-configurable `dmScope`
- User-configurable `maintenance.*`
- IM-specific session policy override
- Per-agent or per-channel session policy
- Custom numeric input for arbitrary durations

These can be added later only if there is clear user demand.

## Testing

- Unit test mapping from `keepAlive` enum to generated `session.reset`
- Unit test generated config always includes explicit `session.maintenance`
- Manual test: change setting, sync config, verify `openclaw.json` updates without invalid structure
- Manual test: leave a conversation idle past the selected threshold and verify the next turn starts a new session
