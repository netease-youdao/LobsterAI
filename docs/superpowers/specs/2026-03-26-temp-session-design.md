# Temporary Session Feature Design

**Date:** 2026-03-26
**Branch:** feature/temp-session

## Overview

Add a small dashed-border clickable button to the right of the "New Task" button in the sidebar. Clicking it opens a temporary conversation session that:

- Does not load or persist any history context
- Does not appear in the session list
- Disappears when the user switches to another task or session
- Cannot be pinned (favorited)
- Cannot be renamed or deleted (no `...` menu)

## UI Entry Point

In `Sidebar.tsx`, the "New Task" row becomes a flex row with two buttons:

```
[ ComposeIcon  New Task ] [ ⚡ ]
                           ^-- dashed border, ~32x32px, tooltip "临时会话"
```

The temp session button uses:
- `border border-dashed` styling
- Same height as other sidebar buttons (`h-8 w-8`)
- A bolt/flash SVG icon (or similar ephemeral symbol)
- Hover: light background matching existing sidebar hover tokens
- Tooltip: "临时会话" / "Temp Session"

## Architecture: Pure Frontend State (Recommended)

Temporary sessions live **entirely in Redux memory** — never written to SQLite, never added to `state.sessions[]`.

### State Changes (`coworkSlice.ts`)

Add a new field to `CoworkState`:

```typescript
tempSession: CoworkSession | null;  // pure in-memory, never persisted
```

New actions:
- `setTempSession(session: CoworkSession | null)` — set/clear the temp session
- `clearTempSession()` — alias for `setTempSession(null)`, also stops any running AI

### Session Lifecycle

1. **Open**: User clicks ⚡ button → `dispatch(clearCurrentSession())` + `dispatch(setTempSession(blankTempSession))`
2. **Active**: `CoworkView` checks `tempSession` first; if set, renders it as the current view
3. **Run**: User submits prompt → calls `coworkService.startSession()` normally (backend creates real Claude session), but the resulting session ID is stored in `tempSession` only, never appended to `state.sessions[]`
4. **Switch away**: User clicks any sidebar session or "New Task" → `dispatch(clearTempSession())` (with stop if running)
5. **Close**: On clear, if `tempSession.status === 'running'`, call `coworkService.stopSession(tempSession.id)`

### Key Invariant

`setCurrentSession()` in the slice already skips `sessions[]` for IDs starting with `temp-`. The temp session's real backend ID will be tracked separately in `tempSession.id` after session creation, while the frontend still treats it as ephemeral by never adding to `sessions[]`.

### `CoworkView.tsx` Changes

- Read `tempSession` from Redux in addition to `currentSession`
- Priority: `tempSession` renders over `currentSession` (or they are mutually exclusive)
- Pass `isTempSession={true}` prop down to `CoworkSessionDetail`

### `CoworkSessionDetail.tsx` Changes

- Accept `isTempSession?: boolean` prop
- When `isTempSession`:
  - Show a "临时会话" label pill in the header (amber/orange color, dashed border style)
  - Hide the `...` menu button entirely (no pin, rename, delete, share)
  - Optionally show a subtle "此会话不会保存" hint below the header

### `Sidebar.tsx` Changes

- `onNewTempSession` callback prop added
- "New Task" row becomes flex row: `onNewChat` button (flex-1) + temp button (fixed width)
- Clicking temp button calls `onNewTempSession`
- When `tempSession` is active, temp button gets a subtle active indicator (same `bg-black/[0.06]` token as active session items)

## Switching Behavior

| User Action | Result |
|---|---|
| Click sidebar session | `clearTempSession()` + `loadSession(id)` |
| Click "New Task" | `clearTempSession()` + `clearCurrentSession()` |
| Click ⚡ again (already in temp) | No-op (already in temp session) |
| Click ⚡ (in regular session) | `clearCurrentSession()` + open temp |
| App restart | Temp session gone (in-memory only) |

## i18n Keys Required

```typescript
// zh
tempSession: '临时会话',
tempSessionHint: '此会话不会保存',

// en
tempSession: 'Temp Session',
tempSessionHint: 'This session will not be saved',
```

## Files to Modify

| File | Change |
|---|---|
| `src/renderer/store/slices/coworkSlice.ts` | Add `tempSession` state + actions |
| `src/renderer/components/Sidebar.tsx` | Add `onNewTempSession` prop + ⚡ button |
| `src/renderer/components/cowork/CoworkView.tsx` | Read `tempSession`, pass `isTempSession` |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | Accept + render `isTempSession` prop |
| `src/renderer/App.tsx` | Wire `onNewTempSession` handler |
| `src/renderer/services/i18n.ts` | Add 2 new i18n keys |

## What is NOT Changed

- No SQLite schema changes
- No IPC channel changes
- No backend/main process changes
- No changes to `CoworkSessionList` or `CoworkSessionItem`
- The "favorite" / pin system is simply hidden, not disabled at data layer
