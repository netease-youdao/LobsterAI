# Send Message Shortcut Feature Design

Date: 2026-04-01

## Overview

Add a configurable send-message shortcut to LobsterAI's cowork chat input. Users can choose from four fixed candidates and switch via a dropdown next to the send button or via the Settings > Shortcuts panel. Both entry points stay in sync through the existing `app_config.shortcuts` store.

## Candidate Shortcut Values

Four fixed options (stored as canonical strings):

| Stored value | Windows/Linux display | macOS display |
|---|---|---|
| `Enter` | Enter | Enter |
| `Shift+Enter` | Shift+Enter | Shift+Enter |
| `Ctrl+Enter` | Ctrl+Enter | Cmd+Enter |
| `Alt+Enter` | Alt+Enter | Option+Enter |

The set is fixed (no free recording). Default: `Enter` (preserves existing behavior).

## Configuration

**File**: `src/renderer/config.ts`

- Add `sendMessage: string` to the `shortcuts` shape.
- Default value: `'Enter'`.
- Persisted as part of `app_config` JSON in SQLite `kv` table, same as existing shortcut keys.

## Keyboard Logic (`CoworkPromptInput.tsx: handleKeyDown`)

Read `configService.getConfig().shortcuts?.sendMessage ?? 'Enter'` at event time.

| sendMessage | Enter key | Shift+Enter | Ctrl/Cmd+Enter | Alt/Option+Enter |
|---|---|---|---|---|
| `Enter` | send | newline | newline | newline |
| `Shift+Enter` | newline | send | newline | newline |
| `Ctrl+Enter` | newline | newline | send | newline |
| `Alt+Enter` | newline | newline | newline | send |

IME composition guard (`isComposing || keyCode === 229`) remains in place for all paths.

## UI: Send Button Area (`CoworkPromptInput.tsx`)

Replace single send button with a compound button group:

```
[ PaperAirplaneIcon ] [ ChevronDownIcon ]
   main send btn         dropdown trigger
```

- Both buttons share `disabled={!canSubmit}` state.
- A `1px` vertical separator (`border-l`) between them uses `border-primary-hover/40`.
- Main button: left rounded corners; dropdown button: right rounded corners.
- Two sizes mirrored: `isLarge` (`rounded-xl`, `h-5 w-5`) and compact (`rounded-lg`, `h-4 w-4`).
- Main button tooltip shows current shortcut label (e.g. `Ctrl+Enter`); hidden when value is `Enter` to avoid visual noise.

**Dropdown menu (floats above input)**

- Controlled by local `useState<boolean>` in `CoworkPromptInput`.
- Position: `bottom-full mb-1 right-0`, absolute, `z-50`.
- Lists 4 candidates; active item shows a checkmark icon.
- Click a candidate: call `configService.updateConfig({ shortcuts: { ...current, sendMessage: value } })` then close.
- Click outside closes via `useEffect` mousedown listener.
- Platform detection: `navigator.platform.includes('Mac')` → render `Cmd` / `Option` instead of `Ctrl` / `Alt`.

## UI: Settings Panel (`Settings.tsx`, shortcuts tab)

Add a new row beneath existing three shortcut rows:

```
发送消息 / Send message    [ <select> Enter ▼ ]
```

- Uses a `<select>` element (not `ShortcutRecorder`) with the four fixed options.
- `onChange` calls `handleShortcutChange('sendMessage', v)`.
- Initialised from `config.shortcuts?.sendMessage ?? 'Enter'`.
- Display labels adapt to macOS platform the same way as the dropdown.

## i18n

Add to both `zh` and `en` sections in `src/renderer/services/i18n.ts`:

| Key | zh | en |
|---|---|---|
| `sendMessage` | 发送消息 | Send message |
| `sendShortcutEnter` | Enter | Enter |
| `sendShortcutShiftEnter` | Shift+Enter | Shift+Enter |
| `sendShortcutCtrlEnter` | Ctrl+Enter (macOS: Cmd+Enter) | Ctrl+Enter (macOS: Cmd+Enter) |
| `sendShortcutAltEnter` | Alt+Enter (macOS: Option+Enter) | Alt+Enter (macOS: Option+Enter) |

Note: Ctrl/Alt display adaptation is done in-component via platform detection rather than separate i18n keys.

## Files to Change

| File | Change |
|---|---|
| `src/renderer/config.ts` | Add `sendMessage: 'Enter'` to `shortcuts` default |
| `src/renderer/components/cowork/CoworkPromptInput.tsx` | Compound button + dropdown + updated `handleKeyDown` |
| `src/renderer/components/Settings.tsx` | New row in shortcuts tab + init/save `sendMessage` |
| `src/renderer/services/i18n.ts` | Add `sendMessage` i18n key |

## Branch & PR

- Branch: `feature/send-shortcut`
- PR targets `main`
- Screenshots of both the dropdown and settings panel required before merge

## Out of Scope

- Free-form shortcut recording for send key (only fixed 4 candidates allowed)
- Any shortcut other than Enter-based combinations
- Changes to the Stop button behavior
