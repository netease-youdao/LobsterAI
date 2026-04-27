# Email Channel Configuration Simplification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the IM bot email channel config UI to show only email address + API Key, with advanced options collapsed.

**Architecture:** UI-only changes to the email section of IMSettings.tsx. Transport mode hardcoded to `'ws'`, account name auto-derived from email prefix. Advanced settings (allowFrom, replyMode, replyTo, A2A) folded into one collapsible section. Data model unchanged for backward compatibility.

**Tech Stack:** React (TypeScript), Tailwind CSS, existing i18n service

---

### Task 1: Update `DEFAULT_EMAIL_INSTANCE_CONFIG` default transport

**Files:**
- Modify: `src/renderer/types/im.ts:435-441`

- [ ] **Step 1: Change the default transport from `'imap'` to `'ws'` and add default `allowFrom`**

```typescript
export const DEFAULT_EMAIL_INSTANCE_CONFIG: Partial<EmailInstanceConfig> = {
  enabled: true,
  transport: 'ws',
  agentId: 'main',
  replyMode: 'complete',
  replyTo: 'sender',
  allowFrom: ['*'],
};
```

- [ ] **Step 2: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/types/im.ts
git commit -m "refactor(im): default email transport to ws and allowFrom to wildcard"
```

---

### Task 2: Add i18n key for sidebar display name

**Files:**
- Modify: `src/renderer/services/i18n.ts`

The sidebar at IMSettings.tsx:1300 uses `i18nService.t('email')` which returns the literal key "email" as fallback. Add the `'email'` key to both language sections to override it.

- [ ] **Step 1: Add `'email'` key to the `zh` section (around line 1326, in the Email Channel block)**

Find the line `channelPrefixEmail: '邮件',` in the `zh` section and add right before it:

```typescript
    email: '龙虾邮箱',
```

- [ ] **Step 2: Add `'email'` key to the `en` section (around line 2802, in the Email Channel block)**

Find the line `channelPrefixEmail: 'Email',` in the `en` section and add right before it:

```typescript
    email: 'clawEmail',
```

- [ ] **Step 3: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/services/i18n.ts
git commit -m "feat(im): rename email channel display to 龙虾邮箱/clawEmail"
```

---

### Task 3: Simplify the email instance config form in IMSettings.tsx

**Files:**
- Modify: `src/renderer/components/im/IMSettings.tsx:1733-2007`

This is the main UI change. The email instance form (lines 1733-2007) needs to be restructured:

**Remove:**
- Instance Name editable input (lines 1734-1744) → replace with read-only display
- Transport Mode radio selector (lines 1747-1775) → remove entirely
- IMAP mode fields block (lines 1791-1852) → remove entirely
- WS mode conditional wrapper (lines 1855-1877) → keep API Key input unconditionally
- Allow From input (lines 1879-1896) → move into advanced section
- Reply Mode dropdown (lines 1898-1914) → move into advanced section
- Reply To radio buttons (lines 1916-1945) → move into advanced section

**Keep as-is:**
- Enable toggle (lines 1694-1715)
- Delete button (lines 1718-1730)
- Email Address input (lines 1777-1788) — with auto-derive instanceName
- API Key input (lines 1859-1876) — now unconditional
- Connectivity test button (lines 2009-2024)

**New behavior:**
- `instanceName` auto-derived from email prefix, persisted on email blur
- `transport` hardcoded to `'ws'` on instance creation and save

- [ ] **Step 1: Replace the entire email instance config form (lines 1733-2007)**

Replace lines 1733-2007 with the following code. This removes the instance name input, transport selector, IMAP fields, and moves allowFrom/replyMode/replyTo into the existing `<details>` advanced section alongside A2A:

```tsx
              {/* Account Name (read-only, derived from email) */}
              <div className="flex items-center gap-2">
                <label className={labelClass}>{i18nService.t('emailInstanceName')}</label>
                <span className="text-sm text-foreground">{inst.instanceName || '—'}</span>
              </div>

              {/* Email Address */}
              <div>
                <label className={labelClass}>{i18nService.t('emailAddress')} <span className="text-red-500">*</span></label>
                <input
                  type="email"
                  value={inst.email}
                  onChange={e => {
                    const email = e.target.value;
                    const instanceName = email.split('@')[0] || '';
                    dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { email, instanceName } }));
                  }}
                  onBlur={e => {
                    const email = e.target.value;
                    const instanceName = email.split('@')[0] || '';
                    void imService.persistEmailInstanceConfig(inst.instanceId, { email, instanceName, transport: 'ws' });
                  }}
                  placeholder={i18nService.t('emailAddressPlaceholder')}
                  className={inputClass}
                />
              </div>

              {/* API Key (always shown, transport is always ws) */}
              <div>
                <label className={labelClass}>{i18nService.t('emailApiKey')} <span className="text-red-500">*</span></label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={inst.apiKey || ''}
                    onChange={e => dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { apiKey: e.target.value } }))}
                    onBlur={e => void imService.persistEmailInstanceConfig(inst.instanceId, { apiKey: e.target.value })}
                    placeholder={i18nService.t('emailApiKeyPlaceholder')}
                    className={`${inputClass} flex-1`}
                  />
                  <button
                    type="button"
                    onClick={() => void handleEmailGetApiKey()}
                    className="px-3 py-2 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors whitespace-nowrap"
                  >
                    {i18nService.t('getApiKey')}
                  </button>
                </div>
                <p className="text-xs text-secondary mt-1">{i18nService.t('apiKeyHint')}</p>
              </div>

              {/* Advanced Options */}
              <details className="group">
                <summary className="cursor-pointer text-xs font-medium text-secondary hover:text-primary transition-colors">
                  {i18nService.t('imAdvancedSettings')}
                </summary>
                <div className="mt-2 space-y-3 pl-2 border-l-2 border-border-subtle">
                  {/* Allow From (whitelist) */}
                  <div>
                    <label className={labelClass}>{i18nService.t('emailAllowFrom')}</label>
                    <input
                      type="text"
                      value={(inst.allowFrom ?? ['*']).join(', ')}
                      onChange={e => dispatch(setEmailInstanceConfig({
                        instanceId: inst.instanceId,
                        config: { allowFrom: e.target.value.split(',').map(s => s.trim()).filter(Boolean) },
                      }))}
                      onBlur={e => void imService.persistEmailInstanceConfig(inst.instanceId, {
                        allowFrom: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                      })}
                      placeholder={i18nService.t('emailAllowFromPlaceholder')}
                      className={inputClass}
                    />
                    <p className="text-xs text-secondary mt-1">{i18nService.t('emailAllowFromHint')}</p>
                  </div>

                  {/* Reply Mode */}
                  <div>
                    <label className={labelClass}>{i18nService.t('emailReplyMode')}</label>
                    <select
                      value={inst.replyMode ?? 'complete'}
                      onChange={e => {
                        const replyMode = e.target.value as EmailInstanceConfig['replyMode'];
                        dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { replyMode } }));
                        void imService.persistEmailInstanceConfig(inst.instanceId, { replyMode });
                      }}
                      className={inputClass}
                    >
                      <option value="immediate">{i18nService.t('emailReplyModeImmediate')}</option>
                      <option value="accumulated">{i18nService.t('emailReplyModeAccumulated')}</option>
                      <option value="complete">{i18nService.t('emailReplyModeComplete')}</option>
                    </select>
                  </div>

                  {/* Reply To */}
                  <div>
                    <label className={labelClass}>{i18nService.t('emailReplyTo')}</label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-1.5 text-sm text-foreground cursor-pointer">
                        <input
                          type="radio"
                          checked={inst.replyTo === 'sender' || !inst.replyTo}
                          onChange={() => {
                            dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { replyTo: 'sender' } }));
                            void imService.persistEmailInstanceConfig(inst.instanceId, { replyTo: 'sender' });
                          }}
                          className="accent-primary"
                        />
                        {i18nService.t('emailReplyToSender')}
                      </label>
                      <label className="flex items-center gap-1.5 text-sm text-foreground cursor-pointer">
                        <input
                          type="radio"
                          checked={inst.replyTo === 'all'}
                          onChange={() => {
                            dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { replyTo: 'all' } }));
                            void imService.persistEmailInstanceConfig(inst.instanceId, { replyTo: 'all' });
                          }}
                          className="accent-primary"
                        />
                        {i18nService.t('emailReplyToAll')}
                      </label>
                    </div>
                  </div>

                  {/* A2A Config */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-secondary">{i18nService.t('emailA2aEnabled')}</span>
                      <button
                        type="button"
                        onClick={() => {
                          const a2aEnabled = !(inst.a2aEnabled ?? true);
                          dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { a2aEnabled } }));
                          void imService.persistEmailInstanceConfig(inst.instanceId, { a2aEnabled });
                        }}
                        className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out cursor-pointer ${
                          (inst.a2aEnabled ?? true) ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-600'
                        }`}
                      >
                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          (inst.a2aEnabled ?? true) ? 'translate-x-4' : 'translate-x-0'
                        }`} />
                      </button>
                    </div>
                    <div>
                      <label className={labelClass}>{i18nService.t('emailA2aAgentDomains')}</label>
                      <input
                        type="text"
                        value={(inst.a2aAgentDomains ?? []).join(', ')}
                        onChange={e => dispatch(setEmailInstanceConfig({
                          instanceId: inst.instanceId,
                          config: { a2aAgentDomains: e.target.value.split(',').map(s => s.trim()).filter(Boolean) },
                        }))}
                        onBlur={e => void imService.persistEmailInstanceConfig(inst.instanceId, {
                          a2aAgentDomains: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                        })}
                        placeholder={i18nService.t('emailA2aAgentDomainsPlaceholder')}
                        className={inputClass}
                      />
                      <p className="text-xs text-secondary mt-1">{i18nService.t('emailA2aAgentDomainsHint')}</p>
                    </div>
                    <div>
                      <label className={labelClass}>{i18nService.t('emailA2aMaxTurns')}</label>
                      <input
                        type="number"
                        value={inst.a2aMaxPingPongTurns ?? 20}
                        onChange={e => {
                          const a2aMaxPingPongTurns = parseInt(e.target.value) || 20;
                          dispatch(setEmailInstanceConfig({ instanceId: inst.instanceId, config: { a2aMaxPingPongTurns } }));
                        }}
                        onBlur={e => void imService.persistEmailInstanceConfig(inst.instanceId, {
                          a2aMaxPingPongTurns: parseInt(e.target.value) || 20,
                        })}
                        className={inputClass}
                      />
                    </div>
                  </div>
                </div>
              </details>
```

- [ ] **Step 2: Hardcode transport to `'ws'` in the add-email-instance handlers**

There are two `addEmailInstance` calls in the file. Update both to use a default name based on the email convention. Since the email isn't known at creation time, keep the placeholder name but ensure transport defaults to ws (already handled by Task 1's DEFAULT_EMAIL_INSTANCE_CONFIG change).

Find at line ~1335:
```tsx
const inst = await imService.addEmailInstance(`Email ${config.email.instances.length + 1}`);
```
No change needed — the `addEmailInstance` backend uses `DEFAULT_EMAIL_INSTANCE_CONFIG` which now defaults to `transport: 'ws'`.

Find at line ~1658:
```tsx
const inst = await imService.addEmailInstance(`Email ${config.email.instances.length + 1}`);
```
No change needed — same reason.

- [ ] **Step 3: Verify build passes**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Visual verification**

Run: `npm run electron:dev`
Check:
- Navigate to IM settings → 龙虾邮箱 sidebar
- Add new email instance → verify only Email Address + API Key fields show
- Type email → verify account name auto-updates
- Expand "Advanced Configuration" → verify allowFrom, replyMode, replyTo, and A2A are inside
- Verify connectivity test button still works

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/im/IMSettings.tsx
git commit -m "feat(im): simplify email channel config to email + api key only"
```

---

### Task 4: Final lint check and cleanup

**Files:**
- May modify: any files from previous tasks

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: No errors related to the changed files

- [ ] **Step 2: Fix any lint issues if present**

Address any ESLint warnings/errors in the modified files.

- [ ] **Step 3: Commit any fixes**

```bash
git add -u
git commit -m "chore: fix lint issues from email channel simplification"
```
