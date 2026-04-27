# Email Channel Toggle & UI Polish

Date: 2026-04-16

## Goal

Three focused UI changes to the IM bot email channel (龙虾邮箱) configuration: update the API Key link, rename an A2A label, and add connectivity validation when enabling an account.

## Changes

### 1. API Key link — add channel parameter

**Current:** `https://claw.163.com/projects/dashboard/#/api-keys`
**New:** `https://claw.163.com/projects/dashboard/?channel=LobsterAI#/api-keys`

**File:** `src/renderer/components/im/IMSettings.tsx` line ~569

### 2. A2A label rename

**Current i18n values:**
- zh: `最大往返次数`
- en: `Max Ping-Pong Turns`

**New i18n values:**
- zh: `A2A最大往返次数`
- en: `A2A Max Ping-Pong Turns`

**Files:** `src/renderer/services/i18n.ts`, `src/main/i18n.ts`

### 3. Toggle default off + connectivity guard

#### Default value change

`DEFAULT_EMAIL_INSTANCE_CONFIG.enabled` changes from `true` to `false` in `src/renderer/types/im.ts`. New email accounts start disabled.

#### Toggle-on behavior

When user clicks the toggle to enable an email instance:

1. **Loading state** — a component-local `emailToggleLoading` state prevents double-clicks. The toggle shows a spinner or disabled appearance while the check runs.
2. **Run connectivity test** — call the existing `runConnectivityTest('email', { email: { instances: [instance] } })` with the active instance.
3. **On pass** — set `enabled: true`, dispatch Redux update, persist via `imService.updateEmailInstanceConfig`, clear errors.
4. **On fail** — keep `enabled: false`, show an alert: "连通性测试失败，请检查配置" (zh) / "Connectivity test failed, please check your configuration" (en).

**Toggle-off** requires no connectivity check — directly set `enabled: false`.

**File:** `src/renderer/components/im/IMSettings.tsx` — the email instance toggle handler around line 1695-1715.

## Files

| File | Change |
|------|--------|
| `src/renderer/components/im/IMSettings.tsx` | API Key URL (#1), toggle handler rewrite (#3) |
| `src/renderer/types/im.ts` | `DEFAULT_EMAIL_INSTANCE_CONFIG.enabled: false` (#3) |
| `src/renderer/services/i18n.ts` | `emailA2aMaxTurns` label (#2), new alert key (#3) |
| `src/main/i18n.ts` | `emailA2aMaxTurns` label (#2) |

## Out of scope

- Backend connectivity test logic (reuse existing)
- Other IM channels
- Email channel data model changes
