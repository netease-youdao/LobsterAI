# Email Channel Integration Design

**Date:** 2026-04-09  
**Status:** Approved  
**Author:** CodeMaker (Claude)

## Overview

This design integrates the `claw-mail-channel` email plugin (`@clawemail/email` v0.9.0) into LobsterAI using the existing multi-instance IM channel architecture. The integration enables users to manage email conversations through the LobsterAI UI with support for both traditional IMAP/SMTP and secure WebSocket transport modes.

## Background

The email channel plugin (`/home/gzlicanyi/work/git/claw-mail-channel`) is a fully-featured OpenClaw extension that supports:

- **Three transport modes:** IMAP/SMTP (traditional), WebSocket (apiKey-based), and IM CLI (mail-cli profile)
- **Real-time email monitoring** via IMAP IDLE or WebSocket push
- **Thread tracking** using standard email headers
- **Multi-account support** with independent configuration per account
- **Advanced features:** whitelist filtering, reply modes, Agent-to-Agent collaboration

### Integration Scope

Based on user requirements, the integration will:

1. ✅ Support **IMAP/SMTP** and **WebSocket** transport modes (IM CLI mode excluded for simplicity)
2. ✅ Use **multi-instance architecture** (like Feishu/QQ) for managing multiple email accounts
3. ✅ Implement **account-level agent binding** (each email account can route to a different agent)
4. ✅ Provide **tiered configuration UI** (basic config + advanced options collapse panel)
5. ✅ Include **browser-based API Key acquisition** flow for WebSocket mode

## Design Approach

### Selected Approach: Full Alignment with Existing IM Pattern (Approach A)

**Rationale:**

- Minimizes code changes by reusing the proven multi-instance infrastructure
- Provides consistent UX across all IM channels (lower learning curve)
- Automatically benefits from future IM system improvements
- Email channel config structure already aligns with OpenClaw standards

**Trade-offs:**

- Must conform to existing multi-instance constraints
- Slight configuration redundancy (stored in both SQLite and openclaw.json)

**Alternatives Considered:**

- **Approach B (Independent config table):** Higher flexibility but larger code footprint and maintenance cost
- **Approach C (Hybrid mode):** Balanced but added complexity in type system and sync logic

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          LobsterAI UI                                │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              EmailSettings.tsx (Renderer)                       │ │
│  │  • Multi-instance list (add/delete/select)                     │ │
│  │  • Instance detail form (basic + advanced)                     │ │
│  │  • "Get API Key" button → opens browser                        │ │
│  │  • Real-time status indicators                                 │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                               ↕ IPC                                  │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              Main Process (Electron)                            │ │
│  │  ┌──────────────────────────────────────────────────────────┐  │ │
│  │  │ IMStore (SQLite)                                          │  │ │
│  │  │  • im_config table: email key → JSON config              │  │ │
│  │  │  • getEmailConfig() / setEmailConfig()                   │  │ │
│  │  └──────────────────────────────────────────────────────────┘  │ │
│  │                         ↓                                        │ │
│  │  ┌──────────────────────────────────────────────────────────┐  │ │
│  │  │ OpenClawConfigSync                                        │  │ │
│  │  │  • Read email config from SQLite                          │  │ │
│  │  │  • Generate openclaw.json channels.email config           │  │ │
│  │  │  • Write environment variables (passwords/apiKeys)        │  │ │
│  │  └──────────────────────────────────────────────────────────┘  │ │
│  │                         ↓                                        │ │
│  │  ┌──────────────────────────────────────────────────────────┐  │ │
│  │  │ OpenClawEngineManager                                     │  │ │
│  │  │  • restartGateway() → loads new config                    │  │ │
│  │  │  • getEmailChannelStatus() → query runtime state          │  │ │
│  │  └──────────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                               ↕ WebSocket
┌─────────────────────────────────────────────────────────────────────┐
│                      OpenClaw Gateway                                │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Email Channel Plugin (@clawemail/email)                       │ │
│  │  • Loads channels.email.accounts from openclaw.json           │ │
│  │  • Per-account: startAccount() → IMAP monitor or WS client    │ │
│  │  • Session format: agent:{agentId}:email:{accountId}:{thread} │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                               ↕
┌─────────────────────────────────────────────────────────────────────┐
│  Email Servers (IMAP/SMTP) or WebSocket Gateway                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

**Configuration Save Flow:**

1. User modifies email config in UI → clicks Save
2. Renderer validates config (email format, required fields, duplicates)
3. IPC call `im:setConfig` with full `IMGatewayConfig` (including email)
4. Main process writes to SQLite `im_config` table
5. `syncOpenClawConfig()` generates `openclaw.json` with `channels.email`
6. `writeEnvFile()` writes `LOBSTER_EMAIL_*_PASSWORD` / `LOBSTER_EMAIL_*_APIKEY`
7. `restartGateway()` reloads OpenClaw with new config
8. Email channel plugin starts monitoring accounts

**Session Discovery Flow:**

1. OpenClaw email plugin receives inbound email
2. Builds sessionKey: `agent:{agentId}:email:{accountId}:{threadId}`
3. Gateway emits chat event with sessionKey
4. `OpenClawChannelSessionSync.parseChannelSessionKey()` extracts platform + conversationId
5. `resolveOrCreateSession()` creates local Cowork session with:
   - Title: `邮件:{threadId}` or `Email:{threadId}`
   - AgentId: read from `emailConfig.instances[accountId].agentId`
6. Session appears in LobsterAI sidebar
7. Streaming chat events update message content in real-time

**Status Monitoring Flow:**

1. Renderer polls `im:getStatus` every 5 seconds
2. Main process calls `openclawEngineManager.getEmailChannelStatus()`
3. Gateway RPC `channel.status` returns per-account connection state
4. Parsed into `EmailMultiInstanceStatus` → returned to renderer
5. UI updates connection indicators (green dot = connected)

## Data Model

### TypeScript Types

```typescript
// src/main/im/types.ts

export interface EmailInstanceConfig {
  instanceId: string; // "email-1", "email-2", etc.
  instanceName: string; // Display name: "Work Email"
  enabled: boolean; // Enable/disable this account

  // Transport mode
  transport: 'imap' | 'ws'; // IMAP/SMTP or WebSocket

  // Account credentials
  email: string; // user@example.com
  password?: string; // Required if transport=imap
  apiKey?: string; // Required if transport=ws (format: ck_*)

  // Agent binding
  agentId: string; // Agent ID (default: "main")

  // IMAP/SMTP servers (optional, auto-detected if empty)
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;

  // Security & policy
  allowFrom?: string[]; // Whitelist: ["user@example.com", "*.trusted.com"]

  // Advanced options
  replyMode?: 'immediate' | 'accumulated' | 'complete';
  replyTo?: 'sender' | 'all';

  // Agent-to-Agent collaboration
  a2aEnabled?: boolean;
  a2aAgentDomains?: string[];
  a2aMaxPingPongTurns?: number;
}

export interface EmailMultiInstanceConfig {
  instances: EmailInstanceConfig[];
}

export interface EmailInstanceStatus {
  instanceId: string;
  instanceName: string;
  connected: boolean;
  startedAt: number | null;
  lastError: string | null;
  email: string | null;
  transport: 'imap' | 'ws' | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
}

export interface EmailMultiInstanceStatus {
  instances: EmailInstanceStatus[];
}

// Default configurations
export const DEFAULT_EMAIL_INSTANCE_CONFIG: Partial<EmailInstanceConfig> = {
  enabled: true,
  transport: 'imap',
  agentId: 'main',
  replyMode: 'complete',
  replyTo: 'sender',
  a2aEnabled: false,
  a2aMaxPingPongTurns: 20,
};

export const DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG: EmailMultiInstanceConfig = {
  instances: [],
};

export const MAX_EMAIL_INSTANCES = 5;
```

### Database Schema

Reuses existing `im_config` table:

```sql
-- Existing table structure
CREATE TABLE IF NOT EXISTS im_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Email config stored as JSON
-- key = 'email'
-- value = JSON.stringify(EmailMultiInstanceConfig)
```

### OpenClaw Configuration Format

`openclaw.json` structure after sync:

```json
{
  "channels": {
    "email": {
      "enabled": true,
      "accounts": {
        "email-1": {
          "enabled": true,
          "name": "Work Email",
          "email": "work@example.com",
          "transport": "imap",
          "password": "${LOBSTER_EMAIL_EMAIL_1_PASSWORD}",
          "allowFrom": ["boss@example.com", "*.company.com"],
          "replyMode": "complete",
          "replyTo": "sender"
        },
        "email-2": {
          "enabled": true,
          "name": "Personal Gmail",
          "email": "personal@gmail.com",
          "transport": "ws",
          "apiKey": "${LOBSTER_EMAIL_EMAIL_2_APIKEY}",
          "a2a": {
            "enabled": true,
            "agentDomains": ["agents.example.com"],
            "maxPingPongTurns": 20
          }
        }
      }
    }
  }
}
```

Environment variables (`.env`):

```bash
LOBSTER_EMAIL_EMAIL_1_PASSWORD=my_imap_password
LOBSTER_EMAIL_EMAIL_2_APIKEY=ck_live_abc123xyz789
```

## Component Details

### 1. Type System Extensions

**Files to modify:**

- `src/main/im/types.ts` - Add `EmailInstanceConfig`, `EmailMultiInstanceConfig`, `EmailInstanceStatus`, `EmailMultiInstanceStatus`, `DEFAULT_EMAIL_*` constants
- `src/shared/platform.ts` - Add `'email'` to `Platform` union type
- `src/main/im/types.ts` - Update `IMGatewayConfig` to include `email: EmailMultiInstanceConfig`
- `src/main/im/types.ts` - Update `IMGatewayStatus` to include `email: EmailMultiInstanceStatus`

**Estimated lines:** ~150

### 2. Configuration Storage

**File:** `src/main/im/imStore.ts`

Add methods:

```typescript
getEmailConfig(): EmailMultiInstanceConfig {
  const raw = this.db
    .prepare('SELECT value FROM im_config WHERE key = ?')
    .get('email') as { value: string } | undefined;

  if (!raw?.value) {
    return DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG;
  }

  const parsed = JSON.parse(raw.value);
  return {
    instances: (parsed.instances || []).map((inst: any) => ({
      ...DEFAULT_EMAIL_INSTANCE_CONFIG,
      ...inst,
    })),
  };
}

setEmailConfig(config: EmailMultiInstanceConfig): void {
  this.db
    .prepare('INSERT OR REPLACE INTO im_config (key, value) VALUES (?, ?)')
    .run('email', JSON.stringify(config));
}
```

**Estimated lines:** ~50

### 3. OpenClaw Configuration Sync

**File:** `src/main/libs/openclawConfigSync.ts`

In `syncOpenClawConfig()` method, add email channel sync block:

```typescript
// Sync Email OpenClaw channel config (multi-instance)
const emailConfig = this.getEmailOpenClawConfig?.();
if (emailConfig?.instances && emailConfig.instances.length > 0) {
  const enabledInstances = emailConfig.instances.filter(i => i.enabled && i.email);

  if (enabledInstances.length > 0) {
    const accounts: Record<string, unknown> = {};

    for (const inst of enabledInstances) {
      const accountId = inst.instanceId;
      const envPrefix = accountId.toUpperCase().replace(/-/g, '_');

      const accountConfig: Record<string, unknown> = {
        enabled: true,
        name: inst.instanceName,
        email: inst.email,
        transport: inst.transport,
      };

      if (inst.transport === 'imap') {
        accountConfig.password = `\${LOBSTER_EMAIL_${envPrefix}_PASSWORD}`;
        if (inst.imapHost) accountConfig.imapHost = inst.imapHost;
        if (inst.imapPort) accountConfig.imapPort = inst.imapPort;
        if (inst.smtpHost) accountConfig.smtpHost = inst.smtpHost;
        if (inst.smtpPort) accountConfig.smtpPort = inst.smtpPort;
      }

      if (inst.transport === 'ws') {
        accountConfig.apiKey = `\${LOBSTER_EMAIL_${envPrefix}_APIKEY}`;
      }

      if (inst.allowFrom?.length) {
        accountConfig.allowFrom = inst.allowFrom;
      }
      if (inst.replyMode) accountConfig.replyMode = inst.replyMode;
      if (inst.replyTo) accountConfig.replyTo = inst.replyTo;

      if (inst.a2aEnabled || inst.a2aAgentDomains?.length || inst.a2aMaxPingPongTurns) {
        accountConfig.a2a = {
          enabled: inst.a2aEnabled ?? true,
          ...(inst.a2aAgentDomains?.length ? { agentDomains: inst.a2aAgentDomains } : {}),
          ...(inst.a2aMaxPingPongTurns ? { maxPingPongTurns: inst.a2aMaxPingPongTurns } : {}),
        };
      }

      accounts[accountId] = accountConfig;
    }

    managedConfig.channels = {
      ...((managedConfig.channels as Record<string, unknown>) || {}),
      email: { enabled: true, accounts },
    };
  }
}
```

In `writeEnvFile()` method, add:

```typescript
// Email credentials
const emailConfig = this.getEmailOpenClawConfig?.();
if (emailConfig?.instances) {
  for (const inst of emailConfig.instances) {
    if (!inst.enabled || !inst.email) continue;
    const envPrefix = `LOBSTER_EMAIL_${inst.instanceId.toUpperCase().replace(/-/g, '_')}`;
    if (inst.transport === 'imap' && inst.password) {
      lines.push(`${envPrefix}_PASSWORD=${inst.password}`);
    }
    if (inst.transport === 'ws' && inst.apiKey) {
      lines.push(`${envPrefix}_APIKEY=${inst.apiKey}`);
    }
  }
}
```

**Estimated lines:** ~80

### 4. Session Mapping

**File:** `src/shared/platform.ts`

Add email platform mapping:

```typescript
static platformOfChannel(channelName: string): Platform | null {
  const mapping: Record<string, Platform> = {
    // ... existing mappings
    'email': 'email',
    'clawemail': 'email',
    'clawemail-email': 'email',
  };
  return mapping[channelName] || null;
}

static channelOf(platform: Platform): string | null {
  const reverseMapping: Record<Platform, string> = {
    // ... existing mappings
    email: 'email',
  };
  return reverseMapping[platform] || null;
}
```

**Estimated lines:** ~10

**File:** `src/main/libs/openclawChannelSessionSync.ts`

Update `getTitlePrefix()` to include email:

```typescript
const prefixByPlatform: Record<Platform, string> = {
  // ... existing prefixes
  email: t('channelPrefixEmail'),
};
```

Update `resolveOrCreateSession()` to handle account-level agent binding:

```typescript
// Extract agentId from email account config
let agentId = 'main';
if (platform === 'email') {
  const parts = sessionKey.split(':');
  if (parts.length >= 5 && parts[2] === 'email') {
    const accountId = parts[3];
    const emailConfig = this.imStore.getEmailConfig();
    const instance = emailConfig.instances.find(i => i.instanceId === accountId);
    if (instance?.agentId) {
      agentId = instance.agentId;
    }
  }
}
```

**Estimated lines:** ~30

### 5. UI Component

**File:** `src/renderer/components/settings/EmailSettings.tsx` (NEW)

Component structure:

```typescript
export const EmailSettings: React.FC = () => {
  // State management
  const [emailConfig, setEmailConfig] = useState<EmailMultiInstanceConfig>();
  const [emailStatus, setEmailStatus] = useState<EmailMultiInstanceStatus>();
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load config and status
  useEffect(() => { loadConfig(); }, []);
  useEffect(() => {
    loadStatus();
    const timer = setInterval(loadStatus, 5000);
    return () => clearInterval(timer);
  }, []);

  // Handlers
  const handleAddInstance = () => { /* ... */ };
  const handleDeleteInstance = (id: string) => { /* ... */ };
  const handleUpdateInstance = (id: string, updates: Partial<EmailInstanceConfig>) => { /* ... */ };
  const handleSave = async () => { /* validate → IPC call → refresh */ };
  const handleGetApiKey = async (instanceId: string) => { /* open browser */ };
  const handleTestConnection = async (instanceId: string) => { /* test IMAP/WS */ };

  return (
    <div className="flex h-full">
      {/* Left: Instance list */}
      <div className="w-64 border-r">
        <button onClick={handleAddInstance}>+ {t('addEmailInstance')}</button>
        {emailConfig?.instances.map(inst => (
          <InstanceCard
            key={inst.instanceId}
            instance={inst}
            status={emailStatus?.instances.find(s => s.instanceId === inst.instanceId)}
            selected={selectedInstanceId === inst.instanceId}
            onSelect={() => setSelectedInstanceId(inst.instanceId)}
            onDelete={() => handleDeleteInstance(inst.instanceId)}
          />
        ))}
      </div>

      {/* Right: Instance detail form */}
      {selectedInstance && (
        <div className="flex-1 p-6 overflow-y-auto">
          {/* Basic config */}
          <section>
            <Input label="instanceName" />
            <RadioGroup label="transport" options={['imap', 'ws']} />
            <Input label="email" type="email" />
            {selectedInstance.transport === 'imap' && (
              <Input label="password" type="password" />
            )}
            {selectedInstance.transport === 'ws' && (
              <div>
                <Input label="apiKey" type="password" />
                <Button onClick={() => handleGetApiKey(selectedInstance.instanceId)}>
                  {t('getApiKey')}
                </Button>
              </div>
            )}
            <Select label="agentId" options={availableAgents} />
            <Textarea label="allowFrom" />
          </section>

          {/* Advanced options (collapsible) */}
          <Collapse title={t('emailAdvancedOptions')}>
            {selectedInstance.transport === 'imap' && (
              <section>
                <h4>{t('emailImapSmtpConfig')}</h4>
                <Input label="imapHost" />
                <Input label="imapPort" type="number" />
                <Input label="smtpHost" />
                <Input label="smtpPort" type="number" />
              </section>
            )}

            <section>
              <h4>{t('emailReplyStrategy')}</h4>
              <Select label="replyMode" options={['immediate', 'accumulated', 'complete']} />
              <RadioGroup label="replyTo" options={['sender', 'all']} />
            </section>

            <section>
              <h4>{t('emailA2aConfig')}</h4>
              <Toggle label="a2aEnabled" />
              {selectedInstance.a2aEnabled && (
                <>
                  <Textarea label="a2aAgentDomains" />
                  <Input label="a2aMaxPingPongTurns" type="number" />
                </>
              )}
            </section>
          </Collapse>

          {/* Actions */}
          <div className="flex gap-2 mt-6">
            <Button onClick={handleTestConnection} disabled={!selectedInstance.email}>
              {t('testConnection')}
            </Button>
            <Button onClick={handleSave} loading={saving} primary>
              {t('save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
```

**Estimated lines:** ~400

### 6. Internationalization

**Files:** `src/main/i18n.ts`, `src/renderer/services/i18n.ts`

Add translation keys for:

- Channel prefix: `channelPrefixEmail`
- Form labels: `emailInstanceName`, `emailAddress`, `emailPassword`, `emailApiKey`, etc.
- UI text: `addEmailInstance`, `getApiKey`, `testConnection`, etc.
- Validation errors: `emailInvalidEmail`, `emailMissingPassword`, `emailDuplicateEmail`, etc.
- Status: `emailConnected`, `emailDisconnected`

**Estimated lines:** ~60 (30 per language)

### 7. Plugin Declaration

**File:** `package.json`

Add to `openclaw.plugins` array:

```json
{
  "id": "clawemail-email",
  "npm": "@clawemail/email",
  "version": "0.9.0"
}
```

For development, support local path via environment variable:

```bash
# .env.local
CLAWEMAIL_LOCAL_PATH=/home/gzlicanyi/work/git/claw-mail-channel/extensions/email
```

**File:** `scripts/ensure-openclaw-plugins.cjs`

Add email plugin to installation logic with local path fallback.

**Estimated lines:** ~15

## Implementation Details

### Transport Mode Switching

The UI must dynamically show/hide fields based on `transport`:

| Field          | IMAP Mode              | WebSocket Mode |
| -------------- | ---------------------- | -------------- |
| Email          | ✅ Required            | ✅ Required    |
| Password       | ✅ Required            | ❌ Hidden      |
| API Key        | ❌ Hidden              | ✅ Required    |
| IMAP Host/Port | ⚙️ Optional (Advanced) | ❌ Hidden      |
| SMTP Host/Port | ⚙️ Optional (Advanced) | ❌ Hidden      |

### API Key Acquisition Flow

**User Experience:**

1. User selects "WebSocket" transport mode
2. User enters email address
3. User clicks "获取 API Key" button
4. System opens default browser to `https://your-clawemail-service.com/get-apikey?email={email}`
5. User completes verification in browser (e.g., email OTP, OAuth)
6. Service displays API Key (format: `ck_live_...`)
7. User copies API Key and pastes into LobsterAI input field
8. User clicks Save

**Technical Implementation:**

```typescript
const handleGetApiKey = async () => {
  const email = selectedInstance.email?.trim();
  if (!email || !isValidEmail(email)) {
    showError('请先填写有效的邮箱地址');
    return;
  }

  const apiKeyUrl = `https://your-clawemail-service.com/get-apikey?email=${encodeURIComponent(email)}`;

  try {
    await window.electron.shell.openExternal(apiKeyUrl);
    showInfo('请在浏览器中完成验证，然后将 API Key 粘贴回来');
  } catch (error) {
    // Fallback: show URL in dialog
    showErrorWithCopy('无法打开浏览器', apiKeyUrl);
  }
};
```

### Account-Level Agent Binding

Each email instance has its own `agentId` field. When a session is created:

1. Parse `accountId` from sessionKey: `agent:main:email:{accountId}:{threadId}`
2. Look up `emailConfig.instances.find(i => i.instanceId === accountId)`
3. Extract `instance.agentId` (default: `'main'`)
4. Create Cowork session with that agentId

This ensures emails to different accounts can route to different agents (e.g., work emails → `work-agent`, personal emails → `main`).

### Configuration Validation

Before saving, validate:

- ✅ Instance count ≤ `MAX_EMAIL_INSTANCES` (5)
- ✅ No duplicate `instanceId` or `email` addresses
- ✅ Valid email format: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
- ✅ IMAP mode requires `password`
- ✅ WebSocket mode requires `apiKey` starting with `ck_`
- ✅ All enabled instances have required fields

Show consolidated error dialog if validation fails.

### Error Handling

**Config Sync Errors:**

- Wrap email sync block in try-catch
- Log error but don't block other IM channels
- Email channel simply won't load in OpenClaw

**Session Parse Errors:**

- If `parseChannelSessionKey` fails for email, fall back to generic channel session
- User can still view conversation history

**Gateway Restart Timeout:**

- Wait up to 30 seconds for gateway restart
- If timeout, show warning but don't rollback config (it's already saved)
- User can manually check gateway logs

**Connection Test:**

- For IMAP: attempt login and list mailboxes
- For WebSocket: attempt token fetch with apiKey
- Display success/failure message with details

## Testing Strategy

### Manual Testing Checklist

**Configuration:**

- [ ] Add email instance (IMAP mode) → save → verify in openclaw.json
- [ ] Add email instance (WebSocket mode) → save → verify apiKey env var
- [ ] Toggle transport mode → verify UI shows/hides correct fields
- [ ] Test validation: empty email, duplicate email, invalid apiKey format
- [ ] Test max instances limit (try to add 6th instance)
- [ ] Delete instance → save → verify removed from config

**Agent Binding:**

- [ ] Set different agentId for each instance
- [ ] Send test emails to both accounts
- [ ] Verify sessions appear under correct agents in sidebar

**API Key Flow:**

- [ ] Click "获取 API Key" → verify browser opens with correct URL
- [ ] Paste apiKey → save → verify stored in env file

**Connection Status:**

- [ ] Start gateway with valid config → verify green "已连接" indicator
- [ ] Stop gateway → verify gray "未连接" indicator
- [ ] Invalid credentials → verify error badge appears

**Session Discovery:**

- [ ] Send inbound email → verify session appears in sidebar
- [ ] Session title format: `邮件:{threadId}`
- [ ] Reply in LobsterAI → verify email sent via SMTP/WebSocket

**Advanced Options:**

- [ ] Configure custom IMAP/SMTP hosts → verify used instead of auto-detected
- [ ] Test replyMode options (immediate/accumulated/complete)
- [ ] Test A2A configuration fields

### Integration Testing

Run existing IM channel tests to ensure no regressions:

```bash
npm test -- im
```

### Development Testing

For local development, use the local plugin path:

```bash
export CLAWEMAIL_LOCAL_PATH=/home/gzlicanyi/work/git/claw-mail-channel/extensions/email
npm run openclaw:plugins
npm run electron:dev:openclaw
```

## Migration & Compatibility

### Forward Compatibility

If future versions change the config format, add migration logic in `getEmailConfig()`:

```typescript
// Detect v1 format (single account) and convert to v2 (multi-instance)
if (parsed.email && !parsed.instances) {
  console.log('[EmailChannel] Migrating from v1 config format');
  return {
    instances: [
      {
        instanceId: 'email-1',
        instanceName: 'Default',
        enabled: parsed.enabled ?? false,
        transport: 'imap',
        email: parsed.email,
        password: parsed.password,
        agentId: 'main',
        ...DEFAULT_EMAIL_INSTANCE_CONFIG,
      },
    ],
  };
}
```

### Backward Compatibility

No existing LobsterAI features are affected:

- Email config is additive (new key in `im_config` table)
- Email platform is new (no conflicts with existing platforms)
- UI adds new Settings tab (no changes to existing tabs)

## Security Considerations

**Password Storage:**

- Passwords and API Keys stored in SQLite (encrypted at rest by OS filesystem)
- Written to `.env` file as plain text (file permissions: 600)
- Environment variables passed to OpenClaw child process (isolated memory space)

**Whitelist Enforcement:**

- `allowFrom` patterns enforced by email channel plugin before dispatching to agent
- Empty whitelist = accept all senders (user must explicitly configure)

**API Key Validation:**

- Client-side format check: must start with `ck_`
- Server-side validation when fetching IM token (via `@clawemail/node-sdk`)
- Invalid apiKey → connection fails with clear error message

**WebSocket Security:**

- WebSocket transport uses TLS (wss://)
- Token authentication for every request
- Email content encrypted in transit

## Performance Considerations

**Config Sync:**

- Triggered only on user Save action (not hot path)
- Gateway restart takes ~2-5 seconds (show loading indicator)

**Status Polling:**

- Poll every 5 seconds (same as other IM channels)
- Batched with other IM status queries (single RPC call)
- Minimal network overhead (~1KB per poll)

**Session Discovery:**

- Existing `pollChannelSessions` runs every 10 seconds
- Email sessions discovered automatically (no additional polling)
- Session list limited to 200 active sessions (configurable)

**UI Rendering:**

- Email settings component only rendered when Settings tab is active
- Instance list virtualized if >20 instances (future optimization)

## Code Estimate Summary

| Component          | Files  | New Lines | Modified Lines |
| ------------------ | ------ | --------- | -------------- |
| Type definitions   | 1      | ~150      | -              |
| IMStore methods    | 1      | ~50       | -              |
| Config sync        | 1      | ~80       | -              |
| Session mapping    | 2      | ~40       | -              |
| UI component       | 1      | ~400      | -              |
| i18n translations  | 2      | ~60       | -              |
| Plugin declaration | 2      | ~15       | -              |
| **Total**          | **10** | **~795**  | **~20**        |

## Open Questions

1. **API Key service URL:** What is the actual URL for the apiKey acquisition page?
   - Placeholder: `https://your-clawemail-service.com/get-apikey`
   - Needs to be updated with real URL before release

2. **Plugin distribution:** Will `@clawemail/email` be published to npm or distributed via private registry?
   - Current design supports both via `localPath` fallback

3. **IM CLI transport:** Should we add support for `mail-cli` profile mode in a future iteration?
   - Currently excluded per user preference (Approach B)

## References

- Email channel plugin: `/home/gzlicanyi/work/git/claw-mail-channel`
- OpenClaw config sync: `src/main/libs/openclawConfigSync.ts`
- Multi-instance reference: Feishu implementation (`src/renderer/components/settings/FeishuSettings.tsx`)
- Session sync: `src/main/libs/openclawChannelSessionSync.ts`
- Gateway manager: `src/main/libs/openclawEngineManager.ts`

## Spec Review Corrections

The following issues were identified during spec review and have been addressed:

### 1. Missing Default Configuration Constants

Added to the TypeScript types section:

```typescript
export const DEFAULT_EMAIL_INSTANCE_CONFIG: Partial<EmailInstanceConfig> = {
  enabled: true,
  transport: 'imap',
  agentId: 'main',
  replyMode: 'complete',
  replyTo: 'sender',
  a2aEnabled: false,
  a2aMaxPingPongTurns: 20,
};

export const DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG: EmailMultiInstanceConfig = {
  instances: [],
};
```

### 2. Environment Variable Naming Simplification

**Changed:** `LOBSTER_EMAIL_EMAIL_1_PASSWORD` → `LOBSTER_EMAIL_1_PASSWORD`

Transformation logic updated to:

```typescript
const envPrefix = `LOBSTER_EMAIL_${inst.instanceId.replace(/^email-/, '').toUpperCase()}`;
// email-1 → LOBSTER_EMAIL_1_PASSWORD
// email-work → LOBSTER_EMAIL_WORK_PASSWORD
```

### 3. Session Key Format Standardization

- **Standardized format:** `agent:{agentId}:email:{accountId}:{threadId}`
- Updated parsing logic to be defensive against threadId containing colons:

```typescript
const emailIndex = parts.indexOf('email');
if (emailIndex !== -1 && emailIndex < parts.length - 2) {
  const accountId = parts[emailIndex + 1];
  const threadId = parts.slice(emailIndex + 2).join(':'); // Handle colons in threadId
}
```

### 4. IPC Channel Specification

Clarified complete IPC API surface:

```typescript
// Email configuration (reuses existing IM channels)
'im:getConfig' → IMGatewayConfig (includes optional email field)
'im:setConfig' → IMGatewayConfig (includes optional email field)
'im:getStatus' → IMGatewayStatus (includes optional email field)

// Agent listing for UI dropdown
'cowork:listAgents' → string[] (agent IDs)

// Connection testing
'email:testConnection' → { instanceId: string } → { success: boolean; error?: string }
```

### 5. Validation Function Definitions

Added utility functions specification:

```typescript
// src/renderer/utils/validation.ts
export const isValidEmail = (email: string): boolean => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

// src/renderer/components/settings/EmailSettings.tsx
const validateConfig = (): string[] => {
  const errors: string[] = [];
  if (emailConfig.instances.length > MAX_EMAIL_INSTANCES) {
    errors.push(t('emailMaxInstancesExceeded', { count: MAX_EMAIL_INSTANCES }));
  }
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  for (const inst of emailConfig.instances) {
    if (seenIds.has(inst.instanceId)) {
      errors.push(t('emailDuplicateInstanceId', { id: inst.instanceId }));
    }
    seenIds.add(inst.instanceId);
    if (seenEmails.has(inst.email)) {
      errors.push(t('emailDuplicateEmail', { email: inst.email }));
    }
    seenEmails.add(inst.email);
    if (!isValidEmail(inst.email)) {
      errors.push(t('emailInvalidEmail', { email: inst.email }));
    }
    if (inst.transport === 'imap' && !inst.password) {
      errors.push(t('emailMissingPassword', { name: inst.instanceName }));
    }
    if (inst.transport === 'ws' && !inst.apiKey) {
      errors.push(t('emailMissingApiKey', { name: inst.instanceName }));
    }
    if (inst.transport === 'ws' && inst.apiKey && !inst.apiKey.startsWith('ck_')) {
      errors.push(t('emailInvalidApiKey', { name: inst.instanceName }));
    }
  }
  return errors;
};
```

### 6. Test Connection Implementation

Added implementation approach:

```typescript
// src/main/main.ts
ipcMain.handle('email:testConnection', async (event, { instanceId }) => {
  try {
    const imStore = getIMGatewayManager().getIMStore();
    const emailConfig = imStore.getEmailConfig();
    const instance = emailConfig.instances.find(i => i.instanceId === instanceId);
    if (!instance) throw new Error('Instance not found');

    if (instance.transport === 'imap') {
      // Use node-imap library directly
      const Imap = require('imap');
      const connection = new Imap({
        user: instance.email,
        password: instance.password,
        host: instance.imapHost || deriveImapHost(instance.email),
        port: instance.imapPort || 993,
        tls: true,
      });
      await new Promise((resolve, reject) => {
        connection.once('ready', () => {
          connection.end();
          resolve();
        });
        connection.once('error', reject);
        connection.connect();
      });
    } else if (instance.transport === 'ws') {
      // Use @clawemail/node-sdk to fetch token
      const { fetchIMToken } = require('@clawemail/node-sdk');
      await fetchIMToken(instance.apiKey, instance.email, console);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});
```

### 7. Agent Binding Race Condition Fix

Updated session resolution to cache config:

```typescript
// In OpenClawChannelSessionSync constructor
this.cachedEmailConfig: EmailMultiInstanceConfig | null = null;
this.configCacheExpiry = 0;

// In resolveOrCreateSession
let agentId = 'main';
if (platform === 'email') {
  // Cache config for 60 seconds to avoid repeated DB reads
  if (!this.cachedEmailConfig || Date.now() > this.configCacheExpiry) {
    this.cachedEmailConfig = this.imStore.getEmailConfig();
    this.configCacheExpiry = Date.now() + 60_000;
  }
  const parts = sessionKey.split(':');
  const emailIndex = parts.indexOf('email');
  if (emailIndex !== -1 && emailIndex < parts.length - 2) {
    const accountId = parts[emailIndex + 1];
    const instance = this.cachedEmailConfig.instances.find(i => i.instanceId === accountId);
    if (instance?.agentId) {
      agentId = instance.agentId;
    }
  }
}
```

### 8. Plugin Installation Error Handling

Added error handling policy:

```javascript
// scripts/ensure-openclaw-plugins.cjs
// Policy: Email plugin installation is non-blocking
for (const plugin of PLUGINS) {
  try {
    if (plugin.localPath && fs.existsSync(plugin.localPath)) {
      console.log(`[Plugin] Using local path for ${plugin.id}: ${plugin.localPath}`);
      fs.symlinkSync(plugin.localPath, pluginDir, 'dir');
    } else {
      console.log(`[Plugin] Installing ${plugin.id}@${plugin.version}`);
      execSync(`npm install ${plugin.npmSpec}@${plugin.version}`, {
        cwd: extensionsDir,
        stdio: 'inherit',
      });
    }
  } catch (error) {
    console.error(`[Plugin] Failed to install ${plugin.id}:`, error.message);
    console.error(`[Plugin] ${plugin.id} will not be available. Continue without it.`);
    // Non-blocking: app starts without this plugin
  }
}
```

### 9. Internationalization Hardcoded Strings

Fixed all hardcoded Chinese strings:

```typescript
// Before:
showError('请先填写有效的邮箱地址');
showInfo('请在浏览器中完成验证，然后将 API Key 粘贴回来');

// After:
showError(t('emailEnterValidEmailFirst'));
showInfo(t('emailVerifyInBrowserAndPaste'));
```

Added missing translation keys:

- `emailEnterValidEmailFirst`
- `emailVerifyInBrowserAndPaste`
- `emailDuplicateInstanceId`

### 10. Runtime Statistics Documentation

Added clarification for `lastInboundAt` / `lastOutboundAt`:

```typescript
// EmailInstanceStatus fields:
// - lastInboundAt: Timestamp of last received email (provided by email plugin runtime)
// - lastOutboundAt: Timestamp of last sent email (provided by email plugin runtime)
// - Both reset to null when OpenClaw gateway restarts (not persisted)
// - UI displays as relative time: "2 minutes ago" using libraries like date-fns
```

### 11. Backward Compatibility

Updated `IMGatewayConfig` and `IMGatewayStatus` to make `email` optional:

```typescript
export interface IMGatewayConfig {
  // ... existing required fields
  email?: EmailMultiInstanceConfig; // Optional: introduced in this version
}

export interface IMGatewayStatus {
  // ... existing required fields
  email?: EmailMultiInstanceStatus; // Optional: introduced in this version
}
```

This ensures older code that doesn't expect the `email` field won't break.

### 12. Type System Clarity

Explicitly documented that `IMGatewayConfig` and `IMGatewayStatus` modifications are part of the `src/main/im/types.ts` changes in the "Type System Extensions" section.

---

## Approval

This design has been reviewed, corrected, and approved for implementation.

**Next Steps:**

1. Write detailed implementation plan using `writing-plans` skill
2. Execute implementation in isolated worktree (if applicable)
3. Run test suite and manual testing checklist
4. Submit PR for code review
