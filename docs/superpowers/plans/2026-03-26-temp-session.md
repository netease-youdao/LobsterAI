# Temporary Session Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small dashed-border button next to "New Task" in the sidebar that opens an ephemeral chat session — no history, not in the session list, cannot be pinned, disappears on switch.

**Architecture:** Pure frontend state approach — `tempSession` lives only in Redux memory, never added to `state.sessions[]`, never written to SQLite. `CoworkView` renders `tempSession` when set, `CoworkSessionDetail` hides the `...` menu when `isTempSession` is true. Switching away clears and stops it.

**Tech Stack:** React, Redux Toolkit, TypeScript, Tailwind CSS. No backend changes.

---

## Chunk 1: Redux State + i18n

### Task 1: Add `tempSession` state and actions to `coworkSlice.ts`

**Files:**
- Modify: `src/renderer/store/slices/coworkSlice.ts`

- [ ] **Step 1: Add `tempSession` field to `CoworkState` interface**

In `src/renderer/store/slices/coworkSlice.ts`, add `tempSession: CoworkSession | null;` to the `CoworkState` interface (after `currentSession`):

```typescript
interface CoworkState {
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  currentSession: CoworkSession | null;
  tempSession: CoworkSession | null;   // <-- add this line
  draftPrompts: Record<string, string>;
  // ...rest unchanged
}
```

- [ ] **Step 2: Add `tempSession: null` to `initialState`**

```typescript
const initialState: CoworkState = {
  sessions: [],
  currentSessionId: null,
  currentSession: null,
  tempSession: null,   // <-- add this line
  // ...rest unchanged
};
```

- [ ] **Step 3: Add `setTempSession` and `clearTempSession` reducers inside `coworkSlice`**

Add these two reducers inside the `reducers` object of `coworkSlice`:

```typescript
setTempSession(state, action: PayloadAction<CoworkSession | null>) {
  state.tempSession = action.payload;
},

clearTempSession(state) {
  state.tempSession = null;
},
```

- [ ] **Step 4: Export the new actions**

Add `setTempSession` and `clearTempSession` to the existing export block at the bottom:

```typescript
export const {
  // ...existing exports...
  setTempSession,
  clearTempSession,
} = coworkSlice.actions;
```

- [ ] **Step 5: Verify TypeScript compiles cleanly**

Run: `npm run build 2>&1 | grep -E "error TS|src/renderer/store"`
Expected: no errors for `coworkSlice.ts`

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/slices/coworkSlice.ts
git commit -m "feat(temp-session): add tempSession state and actions to coworkSlice"
```

---

### Task 2: Add i18n keys for temp session

**Files:**
- Modify: `src/renderer/services/i18n.ts`

- [ ] **Step 1: Add Chinese keys**

Find the `zh` section (it's a large object). Add after `coworkNewSession`:

```typescript
tempSession: '临时会话',
tempSessionHint: '此会话不会保存',
```

- [ ] **Step 2: Add English keys**

Find the `en` section. Add after `coworkNewSession`:

```typescript
tempSession: 'Temp Session',
tempSessionHint: 'This session will not be saved',
```

- [ ] **Step 3: Verify no TypeScript errors**

Run: `npm run build 2>&1 | grep "error TS"`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/services/i18n.ts
git commit -m "feat(temp-session): add i18n keys for temp session"
```

---

## Chunk 2: Sidebar Button

### Task 3: Add temp session button to Sidebar

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`

The "New Task" button currently occupies the full width (`w-full`). We need to split that row into two: the existing "New Task" button (flex-1) and a new small dashed-border button.

- [ ] **Step 1: Add `onNewTempSession` and `isTempSessionActive` to `SidebarProps`**

```typescript
interface SidebarProps {
  // ...existing props...
  onNewTempSession: () => void;
  isTempSessionActive?: boolean;
}
```

Also destructure them in the component function signature:

```typescript
const Sidebar: React.FC<SidebarProps> = ({
  // ...existing...
  onNewTempSession,
  isTempSessionActive = false,
}) => {
```

- [ ] **Step 2: Add a BoltIcon SVG component inside the file (above the component)**

Add this small inline SVG component before `const Sidebar`:

```typescript
const BoltIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <path d="M13 2L4.09 12.96a.5.5 0 0 0 .41.54H11l-1 8.5 8.91-10.96a.5.5 0 0 0-.41-.54H13l1-8.5z" />
  </svg>
);
```

- [ ] **Step 3: Replace the "New Task" button row with a flex row**

Find this block (lines ~152-164):

```tsx
<button
  type="button"
  onClick={onNewChat}
  className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
    activeView === 'cowork'
      ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
      : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
  }`}
>
  <ComposeIcon className="h-4 w-4" />
  {i18nService.t('newChat')}
</button>
```

Replace with:

```tsx
<div className="flex items-center gap-1">
  <button
    type="button"
    onClick={onNewChat}
    className={`flex-1 inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
      activeView === 'cowork' && !isTempSessionActive
        ? 'bg-claude-accent/10 text-claude-accent hover:bg-claude-accent/20'
        : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
    }`}
  >
    <ComposeIcon className="h-4 w-4" />
    {i18nService.t('newChat')}
  </button>
  <button
    type="button"
    onClick={onNewTempSession}
    title={i18nService.t('tempSession')}
    className={`h-8 w-8 inline-flex items-center justify-center rounded-lg border border-dashed transition-colors flex-shrink-0 ${
      isTempSessionActive
        ? 'border-claude-accent text-claude-accent bg-claude-accent/10'
        : 'dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
    }`}
    aria-label={i18nService.t('tempSession')}
  >
    <BoltIcon className="h-3.5 w-3.5" />
  </button>
</div>
```

- [ ] **Step 4: Verify no TypeScript errors**

Run: `npm run build 2>&1 | grep "error TS"`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Sidebar.tsx
git commit -m "feat(temp-session): add dashed temp session button to sidebar"
```

---

## Chunk 3: CoworkView Wiring

### Task 4: Wire temp session in `CoworkView.tsx`

**Files:**
- Modify: `src/renderer/components/cowork/CoworkView.tsx`

- [ ] **Step 1: Read `tempSession` from Redux**

In the selector block (around line 45), add:

```typescript
const {
  currentSession,
  isStreaming,
  config,
  tempSession,           // <-- add this
} = useSelector((state: RootState) => state.cowork);
```

Also import the new actions at the top:

```typescript
import { addMessage, clearCurrentSession, setCurrentSession, setStreaming, updateSessionStatus, setTempSession, clearTempSession } from '../../store/slices/coworkSlice';
```

- [ ] **Step 2: Add `onStartTempSession` prop to `CoworkViewProps`**

```typescript
export interface CoworkViewProps {
  // ...existing...
  onStartTempSession?: () => void;
}
```

And destructure it:

```typescript
const CoworkView: React.FC<CoworkViewProps> = ({ ..., onStartTempSession }) => {
```

- [ ] **Step 3: Add `handleStartTempSession` — opens a blank temp session view**

After the `handleStopSession` function, add:

```typescript
const handleStartTempSession = () => {
  // Clear any regular session first
  dispatch(clearCurrentSession());
  // Create a blank in-memory temp session placeholder
  const now = Date.now();
  dispatch(setTempSession({
    id: `temp-ephemeral-${now}`,
    title: i18nService.t('tempSession'),
    claudeSessionId: null,
    status: 'idle',
    pinned: false,
    cwd: config.workingDirectory || '',
    systemPrompt: '',
    executionMode: config.executionMode || 'local',
    activeSkillIds: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  }));
};
```

- [ ] **Step 4: Add `handleStartTempSessionSession` — submits the first prompt in a temp session**

This is a version of `handleStartSession` that stores the result in `tempSession` instead of `sessions[]`. The existing `setCurrentSession` already skips `sessions[]` for IDs starting with `temp-`, so we can use a similar approach but store into `tempSession` state.

Add after `handleStartTempSession`:

```typescript
const handleStartTempChat = async (prompt: string, skillPrompt?: string, imageAttachments?: CoworkImageAttachment[]): Promise<boolean | void> => {
  if (isStartingRef.current) return;
  isStartingRef.current = true;
  const requestId = ++startRequestIdRef.current;
  pendingStartRef.current = { requestId, cancelled: false };
  const isPendingStartCancelled = () => {
    const pending = pendingStartRef.current;
    return !pending || pending.requestId !== requestId || pending.cancelled;
  };

  try {
    try {
      const apiConfig = await coworkService.checkApiConfig();
      if (apiConfig && !apiConfig.hasConfig) {
        onRequestAppSettings?.({ initialTab: 'model', notice: buildApiConfigNotice(apiConfig.error) });
        isStartingRef.current = false;
        return;
      }
    } catch (error) {
      console.error('Failed to check cowork API config:', error);
    }

    const now = Date.now();
    const fallbackTitle = prompt.split('\n')[0].slice(0, 50) || i18nService.t('tempSession');
    const sessionSkillIds = [...activeSkillIds];

    // Update the temp session in Redux with the user message and running status
    const updatedTempSession: CoworkSession = {
      id: `temp-ephemeral-${now}`,
      title: fallbackTitle,
      claudeSessionId: null,
      status: 'running',
      pinned: false,
      createdAt: now,
      updatedAt: now,
      cwd: config.workingDirectory || '',
      systemPrompt: '',
      executionMode: config.executionMode || 'local',
      activeSkillIds: sessionSkillIds,
      messages: [
        {
          id: `msg-${now}`,
          type: 'user',
          content: prompt,
          timestamp: now,
          metadata: (sessionSkillIds.length > 0 || (imageAttachments && imageAttachments.length > 0))
            ? {
              ...(sessionSkillIds.length > 0 ? { skillIds: sessionSkillIds } : {}),
              ...(imageAttachments && imageAttachments.length > 0 ? { imageAttachments } : {}),
            }
            : undefined,
        },
      ],
    };
    dispatch(setTempSession(updatedTempSession));
    dispatch(setStreaming(true));
    dispatch(clearActiveSkills());
    dispatch(clearSelection());

    let effectiveSkillPrompt = skillPrompt;
    if (!skillPrompt) {
      effectiveSkillPrompt = await skillService.getAutoRoutingPrompt() || undefined;
    }
    const combinedSystemPrompt = [effectiveSkillPrompt, config.systemPrompt]
      .filter(p => p?.trim())
      .join('\n\n') || undefined;

    const { session: startedSession, error: startError } = await coworkService.startSession({
      prompt,
      title: fallbackTitle,
      cwd: config.workingDirectory || undefined,
      systemPrompt: combinedSystemPrompt,
      activeSkillIds: sessionSkillIds,
      imageAttachments,
    });

    if (!startedSession && startError) {
      dispatch(addMessage({
        sessionId: updatedTempSession.id,
        message: {
          id: `error-${Date.now()}`,
          type: 'system',
          content: i18nService.t('coworkErrorSessionStartFailed').replace('{error}', startError),
          timestamp: Date.now(),
        },
      }));
      dispatch(updateSessionStatus({ sessionId: updatedTempSession.id, status: 'error' }));
      return;
    }

    if (isPendingStartCancelled() && startedSession) {
      await coworkService.stopSession(startedSession.id);
    }
  } finally {
    if (pendingStartRef.current?.requestId === requestId) {
      pendingStartRef.current = null;
    }
    isStartingRef.current = false;
  }
};
```

- [ ] **Step 5: Add `handleStopTempSession`**

```typescript
const handleStopTempSession = async () => {
  if (!tempSession) return;
  if (tempSession.id.startsWith('temp-') && pendingStartRef.current) {
    pendingStartRef.current.cancelled = true;
  }
  await coworkService.stopSession(tempSession.id);
};
```

- [ ] **Step 6: Render `tempSession` detail view**

In the return section, before the existing `if (currentSession)` check, add:

```typescript
// Temp session takes priority when active
if (tempSession) {
  return (
    <div className="flex-1 flex flex-col h-full">
      {engineStatusBanner}
      <CoworkSessionDetail
        isTempSession={true}
        onManageSkills={() => onShowSkills?.()}
        onContinue={handleContinueSession}
        onStop={handleStopTempSession}
        onNavigateHome={() => dispatch(clearTempSession())}
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={onToggleSidebar}
        onNewChat={onNewChat}
        updateBadge={updateBadge}
      />
    </div>
  );
}
```

Note: `handleContinueSession` already reads from `currentSession` — we need to adjust it to also support `tempSession`. See Task 5.

- [ ] **Step 7: Expose `handleStartTempSession` via prop call**

In the `useEffect` for `cowork:shortcut:new-session`, also dispatch `clearTempSession`. And expose `handleStartTempSession` via `onStartTempSession` if set.

Actually `onStartTempSession` is not needed as a prop — the sidebar calls it via `App.tsx`. Just make sure `handleStartTempSession` is accessible. We'll wire it in App.tsx in Task 6.

- [ ] **Step 8: Verify TypeScript**

Run: `npm run build 2>&1 | grep "error TS"`

- [ ] **Step 9: Commit**

```bash
git add src/renderer/components/cowork/CoworkView.tsx
git commit -m "feat(temp-session): wire tempSession rendering and handlers in CoworkView"
```

---

### Task 5: Fix `handleContinueSession` to support `tempSession`

The existing `handleContinueSession` reads `currentSession` from Redux. When in temp mode, `currentSession` is null. We need it to also work for `tempSession`.

**Files:**
- Modify: `src/renderer/components/cowork/CoworkView.tsx`

- [ ] **Step 1: Update `handleContinueSession` to fall back to `tempSession`**

Find `handleContinueSession` (around line 291). It starts with:

```typescript
const handleContinueSession = async (...) => {
  if (!currentSession) return;
```

Change to:

```typescript
const handleContinueSession = async (prompt: string, skillPrompt?: string, imageAttachments?: CoworkImageAttachment[]) => {
  const activeSession = currentSession ?? tempSession;
  if (!activeSession) return;
  // ... rest of function: replace `currentSession` with `activeSession`
```

Make sure every reference to `currentSession` inside this function is replaced with `activeSession`.

- [ ] **Step 2: Update `handleStopSession` similarly**

```typescript
const handleStopSession = async () => {
  const activeSession = currentSession ?? tempSession;
  if (!activeSession) return;
  if (activeSession.id.startsWith('temp-') && pendingStartRef.current) {
    pendingStartRef.current.cancelled = true;
  }
  await coworkService.stopSession(activeSession.id);
};
```

- [ ] **Step 3: Verify TypeScript**

Run: `npm run build 2>&1 | grep "error TS"`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/cowork/CoworkView.tsx
git commit -m "feat(temp-session): fix continue/stop to support tempSession"
```

---

## Chunk 4: CoworkSessionDetail + App Wiring

### Task 6: Add `isTempSession` prop to `CoworkSessionDetail`

**Files:**
- Modify: `src/renderer/components/cowork/CoworkSessionDetail.tsx`

- [ ] **Step 1: Add `isTempSession` to `CoworkSessionDetailProps`**

```typescript
interface CoworkSessionDetailProps {
  isTempSession?: boolean;
  // ...existing...
}
```

Destructure it (default `false`):

```typescript
const CoworkSessionDetail: React.FC<CoworkSessionDetailProps> = ({
  isTempSession = false,
  // ...existing...
}) => {
```

- [ ] **Step 2: Hide the `...` menu button when `isTempSession`**

Find the `{/* Menu button */}` section (around line 1942-1951):

```tsx
{/* Menu button */}
<button
  ref={actionButtonRef}
  type="button"
  onClick={openMenu}
  ...
>
  <EllipsisHorizontalIcon className="h-5 w-5" />
</button>
```

Wrap it with a conditional:

```tsx
{/* Menu button — hidden for temp sessions */}
{!isTempSession && (
  <button
    ref={actionButtonRef}
    type="button"
    onClick={openMenu}
    className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
    aria-label={i18nService.t('coworkSessionActions')}
  >
    <EllipsisHorizontalIcon className="h-5 w-5" />
  </button>
)}
```

- [ ] **Step 3: Add a "temp session" pill badge in the header**

Find the header title area where `currentSession.title` is displayed (search for `currentSession.title` in the header section around line 1900+). Right after the title, add the pill when `isTempSession`:

```tsx
{isTempSession && (
  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border border-dashed dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-nowrap">
    {i18nService.t('tempSession')}
  </span>
)}
```

- [ ] **Step 4: Verify TypeScript**

Run: `npm run build 2>&1 | grep "error TS"`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/cowork/CoworkSessionDetail.tsx
git commit -m "feat(temp-session): hide menu and show pill badge for temp sessions"
```

---

### Task 7: Wire `onNewTempSession` in `App.tsx` and clear on session switch

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Import `clearTempSession` and `setTempSession`**

```typescript
import { clearTempSession, setTempSession } from './store/slices/coworkSlice';
```

Also read `tempSession` from state:

```typescript
const tempSession = useSelector((state: RootState) => state.cowork.tempSession);
```

- [ ] **Step 2: Add `handleNewTempSession` callback**

Add after `handleNewChat`:

```typescript
const handleNewTempSession = useCallback(() => {
  // Switch to cowork view
  setMainView('cowork');
  // Clear any regular session
  coworkService.clearSession();
  dispatch(clearSelection());
  // Signal CoworkView to open temp session
  window.dispatchEvent(new CustomEvent('cowork:open-temp-session'));
}, [dispatch]);
```

Since `CoworkView` manages `tempSession` internally via Redux, the simplest approach is to dispatch `setTempSession` directly from App.tsx, but CoworkView needs the config. Better: dispatch a custom event that CoworkView listens to.

Alternative simpler approach: just read `tempSession` as null here and let Sidebar pass `onNewTempSession` → which dispatches the event → CoworkView handles it. See next step.

- [ ] **Step 3: Listen to `cowork:open-temp-session` in `CoworkView`**

In `CoworkView.tsx`, add a `useEffect`:

```typescript
useEffect(() => {
  const handleOpenTempSession = () => {
    handleStartTempSession();
  };
  window.addEventListener('cowork:open-temp-session', handleOpenTempSession);
  return () => {
    window.removeEventListener('cowork:open-temp-session', handleOpenTempSession);
  };
}, [config.workingDirectory, config.executionMode]);
```

Note: `handleStartTempSession` must be stable or captured correctly. Wrap with `useCallback` if needed.

- [ ] **Step 4: Clear `tempSession` when switching to a regular session**

In `App.tsx`, `handleNewChat` currently calls `coworkService.clearSession()`. We also need to clear the temp session. Update it:

```typescript
const handleNewChat = useCallback(() => {
  const shouldClearInput = mainView === 'cowork' || !!currentSessionId;
  coworkService.clearSession();
  dispatch(clearSelection());
  dispatch(clearTempSession());   // <-- add this line
  setMainView('cowork');
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('cowork:focus-input', {
      detail: { clear: shouldClearInput },
    }));
  }, 0);
}, [dispatch, mainView, currentSessionId]);
```

- [ ] **Step 5: Also clear `tempSession` in `Sidebar.handleSelectSession`**

In `Sidebar.tsx`, `handleSelectSession` loads a real session. We need to also clear `tempSession`. The cleanest way is to have `Sidebar` also call a `onSelectSession` that clears it, but Sidebar doesn't have dispatch. Instead, add `onClearTempSession` prop, or simply dispatch in the existing `handleSelectSession` in `Sidebar` by adding a `useDispatch` hook to Sidebar.

Add to `Sidebar.tsx`:

```typescript
import { useSelector, useDispatch } from 'react-redux';
import { clearTempSession } from '../store/slices/coworkSlice';

// Inside the component:
const dispatch = useDispatch();

// Update handleSelectSession:
const handleSelectSession = async (sessionId: string) => {
  dispatch(clearTempSession());
  onShowCowork();
  await coworkService.loadSession(sessionId);
};
```

- [ ] **Step 6: Pass `isTempSessionActive` and `onNewTempSession` from App.tsx to Sidebar**

In `App.tsx` render:

```tsx
<Sidebar
  // ...existing...
  onNewTempSession={handleNewTempSession}
  isTempSessionActive={!!tempSession}
/>
```

- [ ] **Step 7: Verify TypeScript**

Run: `npm run build 2>&1 | grep "error TS"`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/renderer/App.tsx src/renderer/components/Sidebar.tsx src/renderer/components/cowork/CoworkView.tsx
git commit -m "feat(temp-session): wire temp session button through App, Sidebar, and CoworkView"
```

---

## Chunk 5: Edge Cases + Stream Events

### Task 8: Ensure stream events update `tempSession` not `sessions[]`

The cowork service emits stream events (messageUpdate, statusChange, etc.) that go through Redux actions like `addMessage`, `updateMessageContent`, `updateSessionStatus`. These currently check `state.currentSession?.id === sessionId`.

When in temp session mode, `currentSession` is null, but `tempSession` holds the session. We need to make sure stream events also update `tempSession`.

**Files:**
- Modify: `src/renderer/store/slices/coworkSlice.ts`

- [ ] **Step 1: Update `addMessage` reducer to also update `tempSession`**

```typescript
addMessage(state, action: PayloadAction<{ sessionId: string; message: CoworkMessage }>) {
  const { sessionId, message } = action.payload;

  if (state.currentSession?.id === sessionId) {
    const exists = state.currentSession.messages.some((item) => item.id === message.id);
    if (!exists) {
      state.currentSession.messages.push(message);
      state.currentSession.updatedAt = message.timestamp;
    }
  }

  // Also update tempSession if it matches
  if (state.tempSession?.id === sessionId) {
    const exists = state.tempSession.messages.some((item) => item.id === message.id);
    if (!exists) {
      state.tempSession.messages.push(message);
      state.tempSession.updatedAt = message.timestamp;
    }
  }

  // Update session in list (tempSession is never in sessions[], so this is safe)
  const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
  if (sessionIndex !== -1) {
    state.sessions[sessionIndex].updatedAt = message.timestamp;
  }

  markSessionUnread(state, sessionId);
},
```

- [ ] **Step 2: Update `updateMessageContent` reducer similarly**

```typescript
updateMessageContent(state, action: PayloadAction<{ sessionId: string; messageId: string; content: string }>) {
  const { sessionId, messageId, content } = action.payload;

  const updateMessages = (session: CoworkSession | null) => {
    if (!session || session.id !== sessionId) return;
    const messageIndex = session.messages.findIndex(m => m.id === messageId);
    if (messageIndex !== -1) {
      const previousContent = session.messages[messageIndex].content || '';
      if (state.config.agentEngine === 'yd_cowork') {
        session.messages[messageIndex].content = mergeStreamingMessageContent(previousContent, content);
      } else {
        session.messages[messageIndex].content = content;
      }
    }
  };

  updateMessages(state.currentSession);
  updateMessages(state.tempSession);

  markSessionUnread(state, sessionId);
},
```

- [ ] **Step 3: Update `updateSessionStatus` reducer similarly**

```typescript
updateSessionStatus(state, action: PayloadAction<{ sessionId: string; status: CoworkSessionStatus }>) {
  const { sessionId, status } = action.payload;

  const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
  if (sessionIndex !== -1) {
    state.sessions[sessionIndex].status = status;
    state.sessions[sessionIndex].updatedAt = Date.now();
  }

  if (state.currentSession?.id === sessionId) {
    state.currentSession.status = status;
    state.currentSession.updatedAt = Date.now();
    state.isStreaming = status === 'running';
  }

  // Also update tempSession
  if (state.tempSession?.id === sessionId) {
    state.tempSession.status = status;
    state.tempSession.updatedAt = Date.now();
    if (!state.currentSession) {
      state.isStreaming = status === 'running';
    }
  }
},
```

- [ ] **Step 4: Handle the case where `CoworkView` reads `tempSession` for its own session ID**

The `coworkService` stream events use the real backend session ID (not `temp-ephemeral-...`). After `startSession()` succeeds, we get back a `startedSession` with a real ID. We need to update `tempSession.id` to match the real backend ID so stream events can find it.

In `handleStartTempChat` in `CoworkView.tsx`, after `startSession` succeeds:

```typescript
if (startedSession) {
  // Update the temp session with the real backend session ID
  // so stream event reducers can match it
  dispatch(setTempSession({
    ...updatedTempSession,
    id: startedSession.id,
    claudeSessionId: startedSession.claudeSessionId,
  }));
}
```

Also update the `stopSession` call in `handleStopTempSession` to use the current `tempSession.id` (which may have been updated):

```typescript
const handleStopTempSession = async () => {
  const currentTempId = store.getState().cowork.tempSession?.id;
  if (!currentTempId) return;
  if (pendingStartRef.current) {
    pendingStartRef.current.cancelled = true;
  }
  await coworkService.stopSession(currentTempId);
};
```

Import `store` from `../../store` at the top of `CoworkView.tsx`:

```typescript
import { RootState, store } from '../../store';
```

- [ ] **Step 5: Verify TypeScript**

Run: `npm run build 2>&1 | grep "error TS"`

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/slices/coworkSlice.ts src/renderer/components/cowork/CoworkView.tsx
git commit -m "feat(temp-session): ensure stream events update tempSession state"
```

---

## Chunk 6: Final Verification

### Task 9: Manual QA checklist

- [ ] Run `npm run electron:dev` and exercise these flows:

  **Happy path:**
  - [ ] Click the ⚡ button → temp session view opens with "临时会话" pill badge, no `...` menu
  - [ ] Type a prompt and send → AI responds, streaming works
  - [ ] Click a session in the sidebar list → temp session disappears, selected session loads
  - [ ] Click "New Task" → temp session disappears, home screen appears
  - [ ] Click ⚡ again while AI is running → (should handle gracefully, stop current temp)

  **Edge cases:**
  - [ ] Temp session does NOT appear in the session list (left sidebar)
  - [ ] Refreshing/restarting the app → temp session is gone (not persisted)
  - [ ] The `...` menu is hidden in temp session detail view
  - [ ] Pin button is not accessible in temp session

- [ ] Run lint: `npm run lint`
  Expected: no new lint errors

- [ ] Run build: `npm run build`
  Expected: clean build

- [ ] **Final commit**

```bash
git add -A
git commit -m "feat(temp-session): complete temp session feature implementation"
```
