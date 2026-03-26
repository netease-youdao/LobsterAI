# Prevent Sleep Feature Design

## Overview

Add a "prevent sleep" toggle to Settings > General tab, preventing the system from sleeping while LobsterAI is running. Follows the existing autoLaunch pattern.

## User Story

As a user running long AI tasks or IM bots, I want LobsterAI to prevent my computer from sleeping, so tasks aren't interrupted by the system going to sleep.

## Design

### UI

- **Location**: Settings > General tab, below the system proxy toggle
- **Component**: Toggle switch (same style as autoLaunch / useSystemProxy)
- **Behavior**: Toggle takes effect immediately (no save button needed)
- **Label**: 防止休眠 / Prevent Sleep
- **Description**: 防止系统在应用运行时进入睡眠模式 / Prevent the system from sleeping while the app is running

### Architecture

Follows the autoLaunch pattern exactly:

```
Settings.tsx (toggle)
  → window.electron.preventSleep.set(true/false)
  → IPC: app:setPreventSleep
  → main.ts: powerSaveBlocker.start/stop()
  → store.set('prevent_sleep_enabled', boolean)
```

### Main Process (`main.ts`)

- Import `powerSaveBlocker` from `electron`
- Track blocker ID: `let preventSleepBlockerId: number | null = null`
- IPC `app:getPreventSleep`: read from store, return `{ enabled: boolean }`
- IPC `app:setPreventSleep`: start/stop blocker, persist to store
- On app startup: if `prevent_sleep_enabled` is true in store, auto-start blocker
- On app quit: stop blocker if active (cleanup)

### Preload (`preload.ts`)

```typescript
preventSleep: {
  get: () => ipcRenderer.invoke('app:getPreventSleep'),
  set: (enabled: boolean) => ipcRenderer.invoke('app:setPreventSleep', enabled),
},
```

### Type Declaration (`electron.d.ts`)

```typescript
preventSleep: {
  get: () => Promise<{ enabled: boolean }>;
  set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
};
```

### Settings UI (`Settings.tsx`)

- State: `const [preventSleep, setPreventSleep] = useState(false)`
- Loading state: `isUpdatingPreventSleep`
- Init: load from `window.electron.preventSleep.get()` alongside autoLaunch
- Toggle handler: call `window.electron.preventSleep.set(next)`, update state

### i18n (`i18n.ts`)

| Key | zh | en |
|-----|----|----|
| `preventSleep` | 防止休眠 | Prevent Sleep |
| `preventSleepDescription` | 防止系统在应用运行时进入睡眠模式 | Prevent the system from sleeping while the app is running |

### Store

- Key: `prevent_sleep_enabled`
- Type: `boolean`
- Default: `false` (off by default)

### Electron API

- `powerSaveBlocker.start('prevent-display-sleep')` — prevents display sleep (also prevents system sleep)
- `powerSaveBlocker.stop(id)` — releases the blocker
- `powerSaveBlocker.isStarted(id)` — check if active

### Files to Modify

1. `src/main/main.ts` — add `powerSaveBlocker` import, IPC handlers, startup logic
2. `src/main/preload.ts` — add `preventSleep` API
3. `src/renderer/types/electron.d.ts` — add type declaration
4. `src/renderer/components/Settings.tsx` — add toggle in general tab
5. `src/renderer/services/i18n.ts` — add zh/en translations

### Edge Cases

- App quit while blocker active → blocker auto-released by OS when process exits
- Multiple toggles rapidly → loading state prevents double-click
- Store value missing → default to false (off)

### Not In Scope

- Per-session prevent sleep (only during active cowork sessions)
- Tray menu toggle
- System tray indicator showing sleep prevention status
