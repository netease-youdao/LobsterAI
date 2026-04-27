# Email Channel Configuration Simplification

Date: 2026-04-15

## Goal

Simplify the IM bot email channel configuration UI so users only need to provide their email address and API Key. Advanced options are collapsed by default.

## Scope

- **In scope**: Email channel config panel inside IM bot settings (`src/renderer/components/im/IMSettings.tsx` email section only)
- **Out of scope**: Main app flow, the standalone Email tab (`EmailSkillConfig.tsx`), other IM channels, backend email logic

## Changes

### 1. Sidebar display name

- Current: `email`
- New: `龙虾邮箱` (zh) / `clawEmail` (en)
- Files: `src/renderer/services/i18n.ts` (renderer), `src/main/i18n.ts` (main process if referenced)

### 2. Transport mode

- Remove the IMAP/SMTP vs WebSocket radio selector from the UI entirely
- Hardcode `transport: 'ws'` when creating or saving email instances
- Existing IMAP instances continue to work; the UI simply won't expose the choice

### 3. Main panel fields

The configuration panel shows only:

| Field | Required | Notes |
|-------|----------|-------|
| Enable toggle | No | Same as current |
| Email address | Yes | Standard email input |
| API Key | Yes | With "Get API Key" button, validated to start with `ck_` |

### 4. Account name (instanceName)

- Becomes read-only, derived from the email address prefix (text before `@`)
- Updates in real-time when the user types in the email field
- Example: `user@claw.163.com` → account name `user`
- The `instanceName` field is saved to config but never manually editable

### 5. Allow senders default

- Default value: `*` (accept all senders)
- Moved from main panel into the advanced configuration section

### 6. Advanced configuration (collapsed)

All of the following are inside a single collapsible "Advanced Configuration" section:

- **Allowed senders** (allowFrom) — default `*`, comma-separated
- **Reply mode** (replyMode) — default `complete`
- **Reply scope** (replyTo) — default `sender`
- **A2A configuration** — existing collapsible subsection kept as-is

### 7. Removed UI elements

These fields are no longer shown in the UI (backend types remain unchanged for backward compatibility):

- Password field
- IMAP host / port
- SMTP host / port
- Transport mode selector

### 8. Data model

`EmailInstanceConfig` in `src/renderer/types/im.ts`:

- `transport` field remains in the type but defaults to `'ws'` and is not user-selectable
- `password`, `imapHost`, `imapPort`, `smtpHost`, `smtpPort` remain in the type for backward compatibility with existing stored configs
- `DEFAULT_EMAIL_INSTANCE_CONFIG` updated: `transport: 'ws'` (was `'imap'`)

### 9. i18n keys

New/updated keys in `src/renderer/services/i18n.ts`:

| Key | zh | en |
|-----|----|----|
| Sidebar display name | 龙虾邮箱 | clawEmail |

Existing keys for removed fields (transport mode labels, IMAP/SMTP labels, password) are kept in i18n but no longer rendered in the email channel section.

### 10. Validation

- Email address: required, valid email format
- API Key: required, must start with `ck_`
- IMAP-mode validation (`emailMissingPassword`) removed from email channel UI; backend validation unchanged

## Files to modify

1. `src/renderer/components/im/IMSettings.tsx` — email section only
2. `src/renderer/types/im.ts` — update `DEFAULT_EMAIL_INSTANCE_CONFIG`
3. `src/renderer/services/i18n.ts` — add/update translation keys
4. `src/main/i18n.ts` — update sidebar display name if referenced from main process

## Non-goals

- Removing IMAP/SMTP support from the backend or data model
- Changing the email skill configuration tab
- Changing how other IM channels work
