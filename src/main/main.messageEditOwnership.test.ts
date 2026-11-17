import fs from 'node:fs';
import vm from 'node:vm';

import ts from 'typescript';
import { expect, test, vi } from 'vitest';

import { CoworkIpcChannel } from '../shared/cowork/constants';

// Exercise the merged IPC handlers without starting Electron or the gateway.
const source = fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const start = source.indexOf('  const messageEditDeps =');
const end = source.indexOf('  ipcMain.handle(CoworkIpcChannel.SubmitBtw,', start);
const code = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture() {
  let visible = true;
  let epoch = 'account-a';
  const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
  const assertActor = vi.fn(() => { if (!visible) throw new Error('Access denied'); });
  const getMessage = vi.fn(() => ({ content: 'Original' }));
  const pending = vi.fn(() => ({ operationId: 'private-edit' }));
  const prepare = vi.fn(async () => ({ messageSkillIds: ['writing'] }));
  const submitContinue = vi.fn(async () => ({ success: true }));
  const switchMessageVersion = vi.fn(async () => 'version-message');
  const recoverMessageEdit = vi.fn(async () => undefined);
  const submit = vi.fn(async (request: { sessionId: string }, _create: boolean, operation: () => unknown) => {
    assertActor();
    return operation();
  });
  vm.runInNewContext(code, {
    Error, CoworkIpcChannel, ipcMain: { handle: (channel: string, handler: typeof handlers extends Map<string, infer H> ? H : never) => handlers.set(channel, handler) },
    getCoworkStore: () => ({ remote: { assertActor }, getMessage, messageEdits: { pending } }),
    getCurrentRemoteOwner: () => ({ userId: 'a', scopeKey: 'personal' }), getRemoteAccountEpoch: () => epoch,
    canViewCoworkSession: () => visible, getIMGatewayManager: () => null,
    prepareMessageEdit: prepare, submitContinue, remoteSessionCommands: { submit },
    getCoworkEngineRouter: () => ({ switchMessageVersion, recoverMessageEdit }),
    ensureOpenClawRunningForCowork: async () => ({ phase: 'running' }), resolveCoworkTurnModelRef: () => 'model',
    pendingMediaTasks: new Map(), mediaReferencesBySession: new Map(),
    fitImageBytesForModel: vi.fn(), imageEditing: { resolve: vi.fn() },
    console: { error: vi.fn() }, t: (key: string) => key,
  });
  const invoke = (channel: string, request: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, request);
  return { invoke, getMessage, pending, prepare, submit, submitContinue, switchMessageVersion, recoverMessageEdit,
    deny: () => { visible = false; }, changeAccount: () => { epoch = 'account-b'; visible = false; } };
}
const request = { sessionId: 'session', messageId: 'message', prompt: 'Corrected', targetIndex: 1, operationId: 'operation' };

test.each([CoworkIpcChannel.CheckMessageEdit, CoworkIpcChannel.EditMessage, CoworkIpcChannel.SwitchMessageVersion,
  CoworkIpcChannel.RecoverMessageEdit])('rejects foreign-session requests through %s without leaking a pending edit', async channel => {
  const f = fixture(); f.deny();
  expect(await f.invoke(channel, request)).toMatchObject({ success: false });
  expect(f.getMessage).not.toHaveBeenCalled();
  expect(f.pending).not.toHaveBeenCalled();
  expect(f.switchMessageVersion).not.toHaveBeenCalled();
  expect(f.recoverMessageEdit).not.toHaveBeenCalled();
  expect(f.submitContinue).not.toHaveBeenCalled();
});

test('an account switch during attachment preparation prevents resending', async () => {
  const f = fixture();
  f.prepare.mockImplementationOnce(async () => { f.changeAccount(); return { messageSkillIds: [] }; });
  expect(await f.invoke(CoworkIpcChannel.EditMessage, request)).toMatchObject({ success: false });
  expect(f.submitContinue).not.toHaveBeenCalled();
  expect(f.pending).not.toHaveBeenCalled();
});

test('owned edits, version switches and recovery retain their execution lane', async () => {
  const f = fixture();
  expect(await f.invoke(CoworkIpcChannel.EditMessage, request)).toMatchObject({ success: true });
  expect(f.submitContinue).toHaveBeenCalledWith(expect.objectContaining({ editRequest: request }), 1);
  expect(await f.invoke(CoworkIpcChannel.SwitchMessageVersion, request)).toEqual({ success: true, messageId: 'version-message' });
  expect(await f.invoke(CoworkIpcChannel.RecoverMessageEdit, request)).toEqual({ success: true });
  expect(f.submit).toHaveBeenCalledTimes(2);
});

test('pending edit reads hide operations belonging to another account', () => {
  const f = fixture(); f.deny();
  expect(f.invoke(CoworkIpcChannel.GetMessageEdit, request.sessionId)).toEqual({ success: false, pending: undefined });
  expect(f.pending).not.toHaveBeenCalled();
});
