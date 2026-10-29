import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import ts from 'typescript';
import { expect, test, vi } from 'vitest';

// Exercise the real view handler without mounting Electron or unrelated panels.
const sourcePath = fileURLToPath(new URL('./CoworkView.tsx', import.meta.url));
const source = ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer: ts.Expression | undefined;
function find(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'handleStartSession') initializer = node.initializer;
  ts.forEachChild(node, find);
}
find(source);
if (!initializer) throw new Error('CoworkView start handler missing');
const compiled = ts.transpileModule(`globalThis.start = ${initializer.getText(source)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture(success = false) {
  const session = { id: 'persisted-session', status: success ? 'running' : 'error', title: 'Task', messages: [] };
  const actions: Array<{ type: string; payload?: unknown }> = [];
  const action = (type: string) => (payload?: unknown) => ({ type, payload });
  const context = {
    console: { log: vi.fn(), error: vi.fn(), debug: vi.fn() }, Date,
    start: undefined as unknown as (prompt: string) => Promise<boolean | void>,
    CoworkCollaborationMode: { Default: 'default' }, buildSessionTitleInput: (text: string) => text,
    resolveCoworkStartBlock: () => null, blockingHomeQuotaReason: null, openClawStatus: {}, homeStartModel: {},
    isStartingRef: { current: false }, startRequestIdRef: { current: 0 },
    pendingStartRef: { current: null as null | { requestId: number; cancelled: boolean; cancellationAction: string | null } },
    currentSessionIdRef: { current: null as string | null },
    coworkService: {
      checkApiConfig: async () => ({ hasConfig: true }),
      startSession: vi.fn().mockResolvedValue({ success, session, error: success ? undefined : 'Admission failed' }),
      deleteSession: vi.fn().mockResolvedValue(true), stopSession: vi.fn().mockResolvedValue(true),
      generateSessionTitle: vi.fn().mockResolvedValue(undefined),
    },
    COWORK_TEMP_SESSION_ID_PREFIX: 'temp-', buildSessionTitleFromInput: () => 'Task',
    i18nService: { t: (key: string) => key },
    applyOptimisticGoalCommand: vi.fn(() => ({ goal: 'optimistic' })),
    activeSkillIds: [], activeKitIds: [],
    buildCapabilitySelection: () => ({}),
    buildCoworkStartPlan: () => ({ isPlanMode: true, displaySkillIds: [], displayKitIds: [], runtimeSkillIds: [], options: { prompt: 'Task' } }),
    config: {}, currentAgentWorkingDirectory: '/work', currentAgentId: 'main',
    currentAgentSelectedModelRef: 'model', currentAgentSelectedModel: { presetId: 'balanced' }, currentAgentThinkingLevel: undefined,
    currentAgent: {}, homeModelUsesServerQuota: true, mediaSelection: undefined,
    store: { getState: () => ({ cowork: { draftInheritedSkillIds: {} } }) },
    buildGoalSettingMessageMetadata: () => undefined, buildCoworkImageAttachmentPreviews: () => undefined,
    dispatch: (value: { type: string; payload?: unknown }) => actions.push(value),
    setCurrentSession: action('current'), setStreaming: action('streaming'), setDraftCollaborationMode: action('mode'),
    clearActiveSkills: action('clearSkills'), clearActiveKits: action('clearKits'),
    setDraftKitIds: action('draftKits'), setDraftSkillIds: action('draftSkills'), clearSelection: action('clearSelection'),
    addMessage: action('message'), updateSessionStatus: action('status'), updateSessionGoal: action('goal'),
    logCoworkViewModel: vi.fn(),
  };
  vm.runInNewContext(compiled, context);
  return { context, session, actions, start: () => context.start('Task') };
}

test('adopts the failed session ID and stops before title, goal and persisted plan-mode side effects', async () => {
  const f = fixture();
  expect(await f.start()).toBe(false);
  expect(f.context.currentSessionIdRef.current).toBe(f.session.id);
  expect(f.actions).toContainEqual({ type: 'current', payload: f.session });
  expect(f.actions).toContainEqual({ type: 'streaming', payload: false });
  expect(f.context.coworkService.generateSessionTitle).not.toHaveBeenCalled();
  expect(f.context.applyOptimisticGoalCommand).toHaveBeenCalledOnce(); // Only the temporary draft.
  expect(f.actions.some(action => action.type === 'goal')).toBe(false);
  expect(f.actions.filter(action => action.type === 'mode')).toHaveLength(1); // Only the temporary draft.
  expect(f.context.pendingStartRef.current).toBeNull();
  expect(f.context.isStartingRef.current).toBe(false);
});

test.each(['delete', 'stop'])('honors a pending %s when a persisted failure arrives', async cancellationAction => {
  const f = fixture();
  f.context.coworkService.startSession.mockImplementation(async () => {
    f.context.pendingStartRef.current!.cancelled = true;
    f.context.pendingStartRef.current!.cancellationAction = cancellationAction;
    if (cancellationAction === 'delete') f.context.currentSessionIdRef.current = null;
    return { success: false, session: f.session, error: 'Admission failed' };
  });
  expect(await f.start()).toBe(false);
  if (cancellationAction === 'delete') {
    expect(f.context.coworkService.deleteSession).toHaveBeenCalledExactlyOnceWith(f.session.id);
    expect(f.context.currentSessionIdRef.current).toBeNull();
    expect(f.actions).not.toContainEqual({ type: 'current', payload: f.session });
  } else {
    expect(f.context.coworkService.deleteSession).not.toHaveBeenCalled();
    expect(f.context.currentSessionIdRef.current).toBe(f.session.id);
  }
  expect(f.context.coworkService.stopSession).not.toHaveBeenCalled(); // Admission never started execution.
  expect(f.context.coworkService.generateSessionTitle).not.toHaveBeenCalled();
});

test('keeps successful start title and goal behavior', async () => {
  const f = fixture(true);
  await f.start();
  expect(f.context.coworkService.generateSessionTitle).toHaveBeenCalledOnce();
  expect(f.actions.some(action => action.type === 'goal')).toBe(true);
  expect(f.context.applyOptimisticGoalCommand).toHaveBeenCalledTimes(2);
});
