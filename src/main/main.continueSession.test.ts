import fs from 'node:fs';
import vm from 'node:vm';

import ts from 'typescript';
import { expect, test, vi } from 'vitest';

// Run the actual continuation boundary without starting Electron or a gateway.
const source = fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const start = source.indexOf('  const continueCoworkSession =');
const end = source.indexOf('  const submitStart =', start);
const code = ts.transpileModule(`${source.slice(start, end)}\nglobalThis.continueSession = continueCoworkSession;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture() {
  const session = { id: 'session', status: 'idle' };
  const run = { runId: 'run', status: 'starting' };
  const remote = {
    assertActor: vi.fn(), assertNoDeletionEffect: vi.fn(), beginRun: vi.fn(),
    prepareLocalDispatch: vi.fn(), run: () => run,
    markRunDispatched: vi.fn(), settleUndispatchedRun: vi.fn(),
  };
  const runtime = {
    reconcileMessageVersionSwitch: vi.fn().mockResolvedValue(undefined),
    hasPendingMessageEdit: vi.fn().mockReturnValue(false),
    continueSession: vi.fn().mockResolvedValue(undefined), editMessage: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    continueSession: undefined as unknown as (options: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>,
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, Date, Error,
    assertRemoteExecutionPermit: vi.fn(),
    getCoworkStore: () => ({ remote, getSession: () => session, getConfig: () => ({}), messageEdits: { pending: () => null } }),
    getCoworkEngineRouter: () => runtime,
    getCurrentMediaAccountScope: () => null, isMediaAccountScopeSnapshotCurrent: () => true,
    resolveCoworkRunModelRef: () => 'model', resolveCoworkTurnModelRef: () => 'model',
    ensureServerModelReadyForRun: async () => ({ allowed: true }),
    ensureOpenClawRunningForCowork: async () => ({ phase: 'running' }),
    currentRemoteExecution: vi.fn<() => { runId?: string } | undefined>(() => undefined),
    ownershipAccountEpoch: 1, authAccountGeneration: 1,
    waitForDesktopInputCapture: async () => {}, desktopInputCaptureEnabled: () => false,
    assertDesktopInputDispatchCurrent: (_remote: unknown, _id: unknown, _run: unknown, _local: unknown, check: () => void) => check(),
    canViewCoworkSession: () => true,
    containsPlanModePrompt: () => false, mergeCoworkSystemPrompt: () => '',
    normalizeSelectedTextSnippetsForIpc: () => [], normalizeBrowserAnnotationBatches: () => [],
    validateCoworkImageAttachmentsForRuntime: vi.fn<() => { ok: boolean; error?: string }>(() => ({ ok: true })),
    getCoworkImageOriginals: () => ({ retain: () => [] }),
    normalizeMediaSelectionState: () => undefined, mediaDefaults: { turn: async () => undefined },
    getSkinRuntimeController: () => ({ prepareTurn: () => ({}) }), cachedMediaGenerationEntitled: false,
    mediaTurnAccountScopeBySession: new Map(), mediaSelectionBySession: new Map(), mediaReferencesBySession: new Map(),
    pendingMediaTasks: new Map<string, { sessionId: string }>(),
    getTaskUsageAnalytics: () => ({ context: () => undefined }), t: (key: string) => key,
  };
  vm.runInNewContext(code, context);
  return { context, remote, runtime, send: (edit = false) => context.continueSession({
    sessionId: session.id, prompt: 'Continue', ...(edit ? { editRequest: { sessionId: session.id, messageId: 'message', prompt: 'Corrected' } } : {}),
  }) };
}

test.each(['attachment', 'media', 'pending-edit'] as const)('releases a local reservation after %s validation rejects before dispatch', async reason => {
  const f = fixture();
  if (reason === 'attachment') f.context.validateCoworkImageAttachmentsForRuntime.mockReturnValue({ ok: false, error: 'Invalid image' });
  if (reason === 'media') f.context.pendingMediaTasks.set('task', { sessionId: 'session' });
  if (reason === 'pending-edit') f.runtime.hasPendingMessageEdit.mockReturnValueOnce(false).mockReturnValue(true);
  const result = await f.send(reason === 'media');
  expect(result.success).toBe(false);
  expect(result.error).toBe(reason === 'attachment' ? 'Invalid image' : reason === 'media' ? 'coworkEditBusy' : 'coworkEditRecoveryNeeded');
  expect(f.remote.beginRun).toHaveBeenCalledOnce();
  expect(f.remote.settleUndispatchedRun).toHaveBeenCalledWith('session', 'run');
  expect(f.remote.markRunDispatched).not.toHaveBeenCalled();
  expect(f.runtime.continueSession).not.toHaveBeenCalled();
  expect(f.runtime.editMessage).not.toHaveBeenCalled();
});

test.each([false, true])('keeps the runtime reservation after successful dispatch (edit=%s)', async edit => {
  const f = fixture();
  expect(await f.send(edit)).toMatchObject({ success: true });
  expect(f.remote.markRunDispatched).toHaveBeenCalledOnce();
  expect(edit ? f.runtime.editMessage : f.runtime.continueSession).toHaveBeenCalledOnce();
  expect(f.remote.settleUndispatchedRun).not.toHaveBeenCalled();
});

test('leaves rejected mobile execution settlement to the command service', async () => {
  const f = fixture();
  f.context.currentRemoteExecution.mockReturnValue({ runId: 'run' });
  f.context.validateCoworkImageAttachmentsForRuntime.mockReturnValue({ ok: false, error: 'Invalid image' });
  expect(await f.send()).toMatchObject({ success: false, error: 'Invalid image' });
  expect(f.remote.beginRun).not.toHaveBeenCalled();
  expect(f.remote.settleUndispatchedRun).not.toHaveBeenCalled();
});
