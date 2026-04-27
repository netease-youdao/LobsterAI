# Email Channel Toggle & UI Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three focused UI changes to the email channel config: update API Key link, rename A2A label, and add connectivity validation when enabling an account.

**Architecture:** UI-only changes to existing email channel configuration in IMSettings. The connectivity guard reuses the existing `runConnectivityTest` function and adds a local loading state to the email instance toggle.

**Tech Stack:** React (TypeScript), Tailwind CSS, existing i18n service

---

### Task 1: Update API Key link URL

**Files:**
- Modify: `src/renderer/components/im/IMSettings.tsx:569`

- [ ] **Step 1: Change the URL constant**

In `src/renderer/components/im/IMSettings.tsx`, line 569, replace:

```typescript
    const apiKeyUrl = 'https://claw.163.com/projects/dashboard/#/api-keys';
```

with:

```typescript
    const apiKeyUrl = 'https://claw.163.com/projects/dashboard/?channel=LobsterAI#/api-keys';
```

- [ ] **Step 2: Verify the change**

Run: `grep -n 'claw.163.com/projects/dashboard' src/renderer/components/im/IMSettings.tsx`
Expected: single match at line ~569 with the new URL containing `?channel=LobsterAI`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/im/IMSettings.tsx
git commit -m "feat(im): add channel param to email API Key link URL"
```

---

### Task 2: Rename A2A label in i18n

**Files:**
- Modify: `src/renderer/services/i18n.ts` (zh ~line 1368, en ~line 2845)
- Modify: `src/main/i18n.ts` (zh ~line 239, en ~line 523)

- [ ] **Step 1: Update renderer i18n — Chinese**

In `src/renderer/services/i18n.ts`, find the key `emailA2aMaxTurns` in the `zh` section (~line 1368). Replace:

```
emailA2aMaxTurns: '最大往返次数',
```

with:

```
emailA2aMaxTurns: 'A2A最大往返次数',
```

- [ ] **Step 2: Update renderer i18n — English**

In the same file, find `emailA2aMaxTurns` in the `en` section (~line 2845). Replace:

```
emailA2aMaxTurns: 'Max Ping-Pong Turns',
```

with:

```
emailA2aMaxTurns: 'A2A Max Ping-Pong Turns',
```

- [ ] **Step 3: Update main i18n — Chinese**

In `src/main/i18n.ts`, find `emailA2aMaxTurns` in the `zh` section (~line 239). Replace:

```
emailA2aMaxTurns: '最大往返次数',
```

with:

```
emailA2aMaxTurns: 'A2A最大往返次数',
```

- [ ] **Step 4: Update main i18n — English**

In the same file, find `emailA2aMaxTurns` in the `en` section (~line 523). Replace:

```
emailA2aMaxTurns: 'Max Ping-Pong Turns',
```

with:

```
emailA2aMaxTurns: 'A2A Max Ping-Pong Turns',
```

- [ ] **Step 5: Verify no stale values remain**

Run: `grep -rn "最大往返次数\|'Max Ping-Pong Turns'" src/`
Expected: no matches (all four locations updated).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/services/i18n.ts src/main/i18n.ts
git commit -m "feat(im): rename A2A max turns label to include A2A prefix"
```

---

### Task 3: Change email instance default to disabled

**Files:**
- Modify: `src/renderer/types/im.ts:436`

- [ ] **Step 1: Change default enabled value**

In `src/renderer/types/im.ts`, line 436, replace:

```typescript
  enabled: true,
```

with:

```typescript
  enabled: false,
```

(inside `DEFAULT_EMAIL_INSTANCE_CONFIG`).

- [ ] **Step 2: Verify the change**

Run: `grep -n 'enabled' src/renderer/types/im.ts | head -5`
Expected: line 436 shows `enabled: false`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/types/im.ts
git commit -m "feat(im): default new email instances to disabled"
```

---

### Task 4: Add connectivity guard on email toggle

**Files:**
- Modify: `src/renderer/components/im/IMSettings.tsx` — add state (~line 130 area, with other useState hooks), rewrite toggle handler (~lines 1695-1715)
- Modify: `src/renderer/services/i18n.ts` — add alert i18n keys
- Modify: `src/main/i18n.ts` — add alert i18n key

- [ ] **Step 1: Add i18n keys for connectivity failure alert**

In `src/renderer/services/i18n.ts`, add in the `zh` section (near other `email` keys):

```
emailConnectivityFailAlert: '连通性测试失败，请检查配置',
```

In the `en` section:

```
emailConnectivityFailAlert: 'Connectivity test failed, please check your configuration',
```

In `src/main/i18n.ts`, add in the `zh` section (near other `email` keys):

```
emailConnectivityFailAlert: '连通性测试失败，请检查配置',
```

In the `en` section:

```
emailConnectivityFailAlert: 'Connectivity test failed, please check your configuration',
```

- [ ] **Step 2: Add loading state for email toggle**

In `src/renderer/components/im/IMSettings.tsx`, near the other `useState` hooks (around line 118-125), add:

```typescript
  const [emailToggleLoading, setEmailToggleLoading] = useState<string | null>(null);
```

This stores the `instanceId` of the email instance currently being toggled on (null when idle).

- [ ] **Step 3: Rewrite the email instance toggle handler**

In `src/renderer/components/im/IMSettings.tsx`, replace the toggle button `onClick` handler (lines 1697-1703). The current code is:

```typescript
                  onClick={async () => {
                    const newEnabled = !inst.enabled;
                    const success = await imService.updateEmailInstanceConfig(inst.instanceId, { enabled: newEnabled });
                    if (success) {
                      dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { enabled: newEnabled } }));
                      if (newEnabled) dispatch(clearError());
                    }
                  }}
```

Replace with:

```typescript
                  onClick={async () => {
                    const newEnabled = !inst.enabled;

                    // Turning OFF — no connectivity check needed
                    if (!newEnabled) {
                      const success = await imService.updateEmailInstanceConfig(inst.instanceId, { enabled: false });
                      if (success) {
                        dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { enabled: false } }));
                      }
                      return;
                    }

                    // Turning ON — run connectivity test first
                    if (emailToggleLoading) return;
                    setEmailToggleLoading(inst.instanceId);
                    try {
                      const result = await imService.testGateway('email', {
                        email: { instances: [inst] },
                      } as Partial<IMGatewayConfig>);
                      if (result && result.verdict !== 'fail') {
                        const success = await imService.updateEmailInstanceConfig(inst.instanceId, { enabled: true });
                        if (success) {
                          dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { enabled: true } }));
                          dispatch(clearError());
                        }
                      } else {
                        alert(i18nService.t('emailConnectivityFailAlert'));
                      }
                    } finally {
                      setEmailToggleLoading(null);
                    }
                  }}
```

Key decisions:
- `verdict !== 'fail'` allows both `'pass'` and `'warn'` to enable (consistent with how other platforms auto-enable on auth_check pass).
- `imService.testGateway` is called directly instead of `runConnectivityTest` to avoid setting `testingPlatform` (which would interfere with the connectivity test button UI).

- [ ] **Step 4: Add loading visual state to the toggle button**

On the same toggle `<button>` element (line 1695), update the `className` and inner `<span>` to show loading state.

Replace the existing button `className` (lines 1705-1709):

```typescript
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out cursor-pointer ${
                    inst.enabled
                      ? (instStatus?.connected ? 'bg-green-500' : 'bg-yellow-500')
                      : 'bg-gray-400 dark:bg-gray-600'
                  }`}
```

with:

```typescript
                  disabled={emailToggleLoading === inst.instanceId}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                    emailToggleLoading === inst.instanceId
                      ? 'cursor-wait bg-gray-400 dark:bg-gray-600'
                      : 'cursor-pointer'
                  } ${
                    inst.enabled
                      ? (instStatus?.connected ? 'bg-green-500' : 'bg-yellow-500')
                      : 'bg-gray-400 dark:bg-gray-600'
                  }`}
```

And replace the inner `<span>` (lines 1712-1714):

```typescript
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    inst.enabled ? 'translate-x-4' : 'translate-x-0'
                  }`} />
```

with:

```typescript
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full shadow ring-0 transition duration-200 ease-in-out ${
                    emailToggleLoading === inst.instanceId
                      ? 'translate-x-0 bg-gray-300 dark:bg-gray-500 animate-pulse'
                      : inst.enabled
                        ? 'translate-x-4 bg-white'
                        : 'translate-x-0 bg-white'
                  }`} />
```

- [ ] **Step 5: Verify changes compile**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: no errors related to IMSettings.tsx or i18n files.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/im/IMSettings.tsx src/renderer/services/i18n.ts src/main/i18n.ts
git commit -m "feat(im): add connectivity validation on email toggle-on"
```
