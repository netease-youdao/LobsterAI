import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import ts from 'typescript';
import { expect, test, vi } from 'vitest';

import { sameOwner } from './remote/canonical';

// Execute the actual IPC handler with inert model/runtime boundaries.
const sourcePath = fileURLToPath(new URL('./main.ts', import.meta.url));
const source = ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true);
let initializer: ts.Expression | undefined;
function find(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'startCoworkSession') initializer = node.initializer;
  ts.forEachChild(node, find);
}
find(source);
if (!initializer) throw new Error('startCoworkSession handler missing');
const compiled = ts.transpileModule(`globalThis.start = ${initializer.getText(source)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture() {
  const owner = { userId: 'owner', scopeKey: 'personal' };
  const session = { id: 'new-session', status: 'idle', modelOverride: 'model', messages: [] };
  let run: { runId: string; status: string } | null = null;
  const remote = {
    assertActor: vi.fn(), assertNoDeletionEffect: vi.fn(),
    beginRun: vi.fn(() => { run = { runId: 'run', status: 'starting' }; }),
    prepareLocalDispatch: vi.fn(), run: () => run, markRunDispatched: vi.fn(), settleUndispatchedRun: vi.fn(),
  };
  const store = {
    remote, getConfig: () => ({}), getSession: vi.fn(() => session), createSession: vi.fn(() => session),
    recordLocalStartFailure: vi.fn((_id, _owner, input, assertCurrent) => {
      assertCurrent();
      return { ...session, status: 'error', messages: [{ type: 'user', content: input.content }, { type: 'system', content: 'coworkSessionAdmissionFailed' }] };
    }),
    updateSession: vi.fn(), addMessage: vi.fn(),
  };
  const runtime = { startSession: vi.fn().mockResolvedValue(undefined) };
  const context = {
    console: { log: vi.fn(), warn: vi.fn() }, Date, Error,
    start: undefined as unknown as (options: Record<string, unknown>) => Promise<Record<string, any>>,
    execution: { owner } as { owner: typeof owner; preparedSessionId?: string; runId?: string; commandId?: string },
    ownershipAccountEpoch: 1, authAccountGeneration: 1,
    getCurrentMediaAccountScope: vi.fn(() => owner),
    isMediaAccountScopeSnapshotCurrent: (a: unknown, b: unknown) => a === b,
    assertRemoteExecutionPermit: vi.fn(), canViewCoworkSession: vi.fn(() => true),
    parseModelPresetId: (id: string) => id,
    ensureServerModelReadyForRun: vi.fn().mockResolvedValue({ allowed: true }),
    ensureOpenClawRunningForCowork: vi.fn().mockResolvedValue({ phase: 'running' }),
    getEngineNotReadyResponse: () => ({ success: false, code: 'ENGINE_NOT_READY', error: 'Engine unavailable' }),
    getCoworkStore: () => store, mergeCoworkSystemPrompt: () => '', containsPlanModePrompt: () => false,
    resolveSessionWorkingDirectory: () => '/work', resolveTaskWorkingDirectory: () => '/work',
    validateCoworkImageAttachmentsForRuntime: () => ({ ok: true }), stripNullChars: (text: string) => text.replace(/\0/g, ''),
    buildSessionTitleFromInput: () => 'Task', t: (key: string) => key,
    normalizeSelectedTextSnippetsForIpc: () => [], normalizeBrowserAnnotationBatches: (value: unknown) => value ?? [],
    mediaDefaults: { turn: async () => undefined }, normalizeMediaSelectionState: () => undefined,
    getCurrentRemoteOwner: () => owner, sameOwner,
    currentRemoteExecution: () => context.execution,
    buildCoworkImageAttachmentPreviews: () => undefined,
    buildCoworkUserSelectionMetadata: (input: { browserAnnotations: unknown }) => ({ browserAnnotations: input.browserAnnotations }),
    imageEditMessageMetadata: () => ({}),
    modelPresetSelection: { choose: vi.fn().mockRejectedValue(new Error('sensitive upstream detail /internal/path')) },
    getSkinRuntimeController: () => ({ prepareTurn: () => ({}) }), cachedMediaGenerationEntitled: false,
    mediaTurnAccountScopeBySession: new Map(), mediaSelectionBySession: new Map(), mediaReferencesBySession: new Map(),
    desktopInputCaptureEnabled: () => false, remoteBridge: undefined,
    waitForDesktopInputCapture: async () => {},
    assertDesktopInputDispatchCurrent: (_remote: unknown, _id: unknown, _run: unknown, _local: unknown, assertCurrent: () => void) => assertCurrent(),
    getCoworkEngineRouter: () => runtime,
  };
  vm.runInNewContext(compiled, context);
  return { context, store, remote, runtime, session, start: () => context.start({ prompt: 'Original\0 input', modelPresetId: 'balanced', browserAnnotations: [{ text: 'Selected comment' }] }) };
}

test('preset admission failure returns the retained local session with failure semantics and sanitized input', async () => {
  const f = fixture();
  const result = await f.start();
  expect(result).toMatchObject({ success: false, error: 'sensitive upstream detail /internal/path', session: { id: 'new-session', status: 'error' } });
  expect(f.store.recordLocalStartFailure).toHaveBeenCalledWith('new-session', f.context.execution.owner,
    { content: 'Original input', metadata: { browserAnnotations: [{ text: 'Selected comment' }] }, timestamp: expect.any(Number) }, expect.any(Function));
  expect(JSON.stringify(result.session)).not.toContain('sensitive upstream');
  expect(f.store.recordLocalStartFailure.mock.calls[0][2]).not.toHaveProperty('error');
  expect(f.remote.beginRun).not.toHaveBeenCalled();
  expect(f.runtime.startSession).not.toHaveBeenCalled();
});

test('engine admission failure retains the session without converting ENGINE_NOT_READY to success', async () => {
  const f = fixture();
  f.context.modelPresetSelection.choose.mockResolvedValue(f.session);
  f.context.ensureOpenClawRunningForCowork.mockResolvedValue({ phase: 'error' });
  expect(await f.start()).toMatchObject({ success: false, code: 'ENGINE_NOT_READY', session: { id: 'new-session' } });
  expect(f.store.recordLocalStartFailure).toHaveBeenCalledOnce();
  expect(f.remote.beginRun).not.toHaveBeenCalled();
});

test.each(['preparedSessionId', 'runId', 'commandId'] as const)('excludes remote %s from local failure persistence', field => {
  const f = fixture();
  f.context.execution[field] = 'remote-id';
  return f.start().then(result => {
    expect(result.success).toBe(false);
    expect(result.session).toBeUndefined();
    expect(f.store.recordLocalStartFailure).not.toHaveBeenCalled();
  });
});

test.each(['epoch', 'scope', 'visibility', 'permit', 'actor'] as const)('does not retain or expose a failure after %s changes', async change => {
  const f = fixture();
  f.context.modelPresetSelection.choose.mockImplementation(async () => {
    if (change === 'epoch') f.context.ownershipAccountEpoch += 2; // Includes A -> B -> A.
    if (change === 'scope') f.context.getCurrentMediaAccountScope.mockReturnValue({ userId: 'other', scopeKey: 'personal' });
    if (change === 'visibility') f.context.canViewCoworkSession.mockReturnValue(false);
    if (change === 'permit') f.context.assertRemoteExecutionPermit.mockImplementation(() => { throw new Error('Permit revoked'); });
    if (change === 'actor') f.remote.assertActor.mockImplementation(() => { throw new Error('Actor changed'); });
    throw new Error('Admission failed');
  });
  const result = await f.start();
  expect(result.success).toBe(false);
  expect(result.session).toBeUndefined();
  expect(f.store.updateSession).not.toHaveBeenCalled();
  expect(f.runtime.startSession).not.toHaveBeenCalled();
});

test('successful preset admission writes the original message once and dispatches once', async () => {
  const f = fixture();
  f.context.modelPresetSelection.choose.mockResolvedValue(f.session);
  expect(await f.start()).toMatchObject({ success: true, session: { id: 'new-session' } });
  expect(f.store.recordLocalStartFailure).not.toHaveBeenCalled();
  expect(f.store.addMessage).toHaveBeenCalledOnce();
  expect(f.remote.beginRun).toHaveBeenCalledOnce();
  expect(f.runtime.startSession).toHaveBeenCalledOnce();
});


test.each(['preset', 'engine'])('does not retry or return a session when retaining a %s failure hits a storage error', async stage => {
  const f = fixture();
  if (stage === 'engine') {
    f.context.modelPresetSelection.choose.mockResolvedValue(f.session);
    f.context.ensureOpenClawRunningForCowork.mockResolvedValue({ phase: 'error' });
  }
  f.store.recordLocalStartFailure.mockImplementationOnce(() => { throw new Error('Storage unavailable'); });
  const result = await f.start();
  expect(result).toMatchObject({ success: false, error: 'Storage unavailable' });
  expect(result.session).toBeUndefined();
  expect(f.store.recordLocalStartFailure).toHaveBeenCalledOnce();
  expect(f.runtime.startSession).not.toHaveBeenCalled();
});
