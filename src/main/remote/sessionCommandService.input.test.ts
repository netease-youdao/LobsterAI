import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import { RemoteInputOperationPhase, RemoteInputReason, type RemoteResolvedInput } from '../../shared/remote/input';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { payloadHash } from './canonical';
import type { InputPreparationService, LocalPreparedInput } from './inputPreparationService';
import type { InboxEntry } from './remoteBridge';
import type { RemoteModelCatalog } from './remoteModelCatalog';
import { RemoteStore } from './remoteStore';
import { assertRemoteExecutionPermit, markRemoteExecutionDispatched, SessionCommandService } from './sessionCommandService';

const owner = { userId: 'A', scopeKey: 'personal' };
const resources: Array<() => void> = [];
afterEach(() => { for (const dispose of resources.splice(0)) dispose(); });
function fixture(create = false, initialTargetId: string | null = null) {
  let targetId = initialTargetId;
  const cwd = mkdtempSync(path.join(tmpdir(), 'input-command-'));
  const db = new Database(':memory:'); resources.push(() => { db.close(); rmSync(cwd, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,agent_id TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const remote = new RemoteStore(db);
  let modelOverride = 'provider/old'; let thinkingLevel = 'low';
  const insert = (model: string, thinking: string): { id: string } => {
    modelOverride = model; thinkingLevel = thinking;
    db.prepare("INSERT INTO cowork_sessions VALUES('local','Task',1,1,'idle','main',?,?)").run(model, thinking);
    remote.assignNew('local', owner, 'local_create'); remote.bindRemote('local', 'remote', 'pc'); return { id: 'local' };
  };
  if (!create) remote.transaction(() => insert(modelOverride, thinkingLevel));
  const store = { remote, getConfig: () => ({ systemPrompt: '' }), assertAgentAccess: vi.fn(),
    getSession: () => ({ id: 'local', agentId: 'main', cwd, modelOverride, thinkingLevel }),
    getAgent: () => ({ enabled: true, model: 'provider/new' }),
    agentOwnership: { get: () => ({ version: '1', ownerKind: 'default', deletedAt: null }), canView: () => true },
    createSession: (_title: string, _cwd: string, _prompt: string, _mode: string, _skills: string[], _agent: string, model: string, options: any) => insert(model, options.thinkingLevel),
    updateSession: (_id: string, patch: any) => {
      modelOverride = patch.modelOverride ?? modelOverride; thinkingLevel = patch.thinkingLevel ?? thinkingLevel;
      remote.transaction(() => db.prepare('UPDATE cowork_sessions SET model_override=?,thinking_level=? WHERE id=?').run(modelOverride, thinkingLevel, 'local'));
    } } as unknown as CoworkStore;
  const runtime = Object.assign(new EventEmitter(), { patchSession: vi.fn(async (): Promise<any> => ({ modelOverride: 'provider/new' })) });
  const service = new SessionCommandService(store, runtime as unknown as CoworkRuntime, () => owner);
  const input: RemoteResolvedInput = { text: 'hello', agentId: 'main', expectedAgentVersion: '1', workspaceId: 'ws',
    model: { modelRef: 'new-model', version: '1' }, options: { thinkingLevel: 'high' }, attachments: [] };
  const manifest = { preparationId: 'prep', deviceId: 'pc', owner, targetId: targetId ?? undefined, resolvedInput: input, inputDigest: payloadHash(input), runtimeRef: 'provider/new', cwd } as LocalPreparedInput;
  const preparations = { read: () => manifest, validate: vi.fn(), bind: vi.fn(), executionOptions: async () => ({ prompt: 'hello', modelOverride: 'provider/new', thinkingLevel: 'high', imageAttachments: [] }) } as unknown as InputPreparationService;
  const resolveModel = vi.fn(() => {
    if (targetId !== initialTargetId) throw new Error('Old model reference is unavailable on the current target');
    return { item: { modelRef: 'new-model', version: '1', source: 'custom', displayName: 'Chat', providerLabel: 'Custom' } };
  });
  const models = { resolve: resolveModel } as unknown as RemoteModelCatalog;
  service.configureInput({ preparations, models, getDeviceId: () => 'pc', getTargetId: () => targetId });
  const send = vi.fn(async () => { assertRemoteExecutionPermit(); markRemoteExecutionDispatched(); return { success: true }; });
  service.configure(options => service.submit(options, true, send), options => service.submit(options, false, send));
  const request = { commandId: 'cmd', type: create ? 'create_session' : 'send_message', inputSchemaVersion: 2, sessionId: 'remote',
    expectedControlVersion: remote.controlVersion('local'), expectedInputVersion: create ? '0' : remote.inputVersion('local'),
    payload: { inputPreparationId: 'prep', inputDigest: manifest.inputDigest, resolvedInput: input } };
  const command = { commandId: 'cmd', type: request.type, request, requestHash: payloadHash(request), sessionId: 'remote', runId: 'run',
    status: 'claimed', statusVersion: '1', expiresAt: new Date(Date.now() + 60000).toISOString() };
  const binding = remote.transaction(() => service.prepare(command, owner, create ? cwd : null));
  const entry: InboxEntry = { targetId: targetId ?? undefined, command, owner, ...binding, state: 'executing', result: null };
  return { service, remote, runtime, send, entry, store, resolveModel, switchTarget(next: string | null) { targetId = next; } };
}
it('starts a v2 task with the frozen session model and thinking override', async () => {
  const { service, entry, store, runtime, send } = fixture(true);
  expect(store.getSession('local', 0)).toMatchObject({ modelOverride: 'provider/new', thinkingLevel: 'high' });
  await expect(service.execute(entry, () => true)).resolves.toEqual({ outcome: 'started' });
  expect(runtime.patchSession).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledTimes(1);
});
it('keeps model application and sending in one lane and accepts its own version increment', async () => {
  const { service, entry, runtime, remote, send } = fixture(); let finish!: () => void;
  runtime.patchSession.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const execution = service.execute(entry, () => true);
  await vi.waitFor(() => expect(runtime.patchSession).toHaveBeenCalledTimes(1));
  await expect(service.patchConfiguration('local', { model: 'provider/other' })).rejects.toThrow(RemoteInputReason.Busy);
  expect(send).not.toHaveBeenCalled(); finish();
  await expect(execution).resolves.toEqual({ outcome: 'started' });
  expect(remote.inputVersion('local')).toBe('1');
  expect(remote.get('inputOperation:cmd')).toMatchObject({ beforeVersion: '0', afterVersion: '1' });
  expect(send).toHaveBeenCalledTimes(1);
});
it('publishes a confirmed model change even when the send expires during patch', async () => {
  const { service, entry, runtime, remote, send, store } = fixture(); let finish!: () => void; let permitted = true;
  runtime.patchSession.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const execution = service.execute(entry, () => permitted);
  await vi.waitFor(() => expect(runtime.patchSession).toHaveBeenCalledTimes(1));
  permitted = false; finish();
  await expect(execution).rejects.toThrow(RemoteInputReason.Expired);
  expect(store.getSession('local', 0)?.modelOverride).toBe('provider/new');
  expect(remote.inputVersion('local')).toBe('1'); expect(remote.get('inputFence:local')).toBeNull();
  expect(send).not.toHaveBeenCalled();
});
it('retains a confirmed model patch without publishing old service references after a target switch', async () => {
  const f = fixture(false, 'target-a'); let finish!: () => void;
  f.runtime.patchSession.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const execution = f.service.execute(f.entry, () => true);
  await vi.waitFor(() => expect(f.runtime.patchSession).toHaveBeenCalledOnce());
  expect(f.remote.get('inputFence:local')).toMatchObject({ operationId: 'cmd', syncTargetId: 'target-a' });
  f.resolveModel.mockClear();
  f.switchTarget('target-b');
  const currentModel = { modelRef: 'target-b-model', version: '2' };
  f.remote.put('inputModel:local', currentModel);
  const rejected = expect(execution).rejects.toThrow(RemoteInputReason.Expired);
  finish(); await rejected;
  expect(f.store.getSession('local', 0)).toMatchObject({ modelOverride: 'provider/new', thinkingLevel: 'high' });
  expect(f.remote.inputVersion('local')).toBe('1');
  expect(f.remote.get('inputFence:local')).toBeNull();
  expect(f.remote.get('inputOperation:target-a:cmd')).toMatchObject({ phase: 'model_applied', afterVersion: '1' });
  expect(f.remote.get('inputOperation:target-b:cmd')).toBeNull();
  // The real model change invalidates B's derived summary; A's IDs must not replace it.
  expect(f.remote.get('inputModel:local')).toBeNull();
  expect(f.remote.get('inputRun:run')).toBeNull();
  expect(f.resolveModel).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});
it('does not clear a replacement target fence after an old patch finishes', async () => {
  const f = fixture(false, 'target-a'); let finish!: () => void;
  f.runtime.patchSession.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const execution = f.service.execute(f.entry, () => true);
  await vi.waitFor(() => expect(f.runtime.patchSession).toHaveBeenCalledOnce());
  f.switchTarget('target-b');
  const replacement = { ...f.remote.get<Record<string, unknown>>('inputFence:local'), syncTargetId: 'target-b' };
  f.remote.put('inputFence:local', replacement);
  const rejected = expect(execution).rejects.toThrow(RemoteInputReason.Busy);
  finish(); await rejected;
  expect(f.remote.get('inputFence:local')).toEqual(replacement);
  expect(f.remote.get('inputOperation:target-b:cmd')).toBeNull();
  expect(f.send).not.toHaveBeenCalled();
});
it('retains a durable fence for an unknown model patch instead of unlocking on timeout', async () => {
  const { service, entry, runtime, remote, send } = fixture();
  runtime.patchSession.mockImplementation(async () => {
    remote.put('inputFence:local', { ...remote.get<Record<string, unknown>>('inputFence:local'), phase: RemoteInputOperationPhase.Dispatched, gatewayProcessPid: 1234 });
    throw new Error('transport result unknown');
  });
  await expect(service.execute(entry, () => true)).rejects.toThrow('transport result unknown');
  expect(remote.get('inputFence:local')).toMatchObject({ operationId: 'cmd', phase: RemoteInputOperationPhase.Dispatched });
  remote.updateRun('local', 'failed');
  await expect(service.patchConfiguration('local', { model: 'provider/other' })).rejects.toMatchObject({ reason: RemoteInputReason.Busy });
  expect(send).not.toHaveBeenCalled();
});
it('rejects tampered prepared references before creating a run or patching the gateway', () => {
  const { service, entry, runtime } = fixture();
  const changed = structuredClone(entry.command); changed.request.payload.resolvedInput.text = 'changed';
  expect(() => service.prepare(changed, owner, null)).toThrow(RemoteInputReason.Stale);
  expect(runtime.patchSession).not.toHaveBeenCalled();
});
