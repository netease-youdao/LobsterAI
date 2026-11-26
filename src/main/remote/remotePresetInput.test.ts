import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import { ModelPresetId } from '../../shared/modelPresets/constants';
import { RemoteInputMode, RemoteInputReason, type RemotePreparationClaim } from '../../shared/remote/input';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { payloadHash } from './canonical';
import { inputOperationKey, InputPreparationService } from './inputPreparationService';
import type { InboxEntry } from './remoteBridge';
import { type LocalRemoteModel, RemoteModelCatalog } from './remoteModelCatalog';
import { RemoteStore } from './remoteStore';
import { assertRemoteExecutionPermit, markRemoteExecutionDispatched, SessionCommandService } from './sessionCommandService';

const owner = { userId: 'A', scopeKey: 'personal' };
const resources: Array<() => void> = [];
afterEach(() => { for (const dispose of resources.splice(0)) dispose(); vi.restoreAllMocks(); });
function fixture(initialThinking = 'high', aliasThinking: LocalRemoteModel['thinking'] = { options: [] }) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'remote-preset-'));
  const db = new Database(':memory:');
  resources.push(() => { db.close(); rmSync(cwd, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT,model_preset_id TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  db.prepare("INSERT INTO cowork_sessions VALUES('local','Task',1,1,'idle','provider/model',?,?)").run(initialThinking, ModelPresetId.Balanced);
  const remote = new RemoteStore(db);
  remote.transaction(() => { remote.assignNew('local', owner, 'local_create'); remote.bindRemote('local', 'remote', 'pc'); });
  let actor: typeof owner | null = owner, target = 'target-a';
  const session = { id: 'local', agentId: 'main', cwd, modelOverride: 'provider/model', thinkingLevel: initialThinking, modelPresetId: ModelPresetId.Balanced as ModelPresetId | null };
  const store = { remote, getConfig: () => ({ systemPrompt: '' }), assertAgentAccess: vi.fn(), getSession: () => ({ ...session }),
    getAgent: () => ({ enabled: true, model: 'provider/model' }),
    agentOwnership: { get: () => ({ version: '1', ownerKind: 'default', deletedAt: null }), canView: () => true },
    updateSession: (_id: string, patch: Record<string, unknown>) => {
      Object.assign(session, patch);
      remote.transaction(() => db.prepare('UPDATE cowork_sessions SET model_override=?,thinking_level=?,model_preset_id=? WHERE id=?')
        .run(session.modelOverride, session.thinkingLevel, session.modelPresetId, 'local'));
    } } as unknown as CoworkStore;
  const locals: LocalRemoteModel[] = [
    { identity: 'physical', runtimeRef: 'provider/model', source: 'custom', displayName: 'Physical model', providerLabel: 'Custom', available: true,
      image: true, toolCalling: true, thinking: { options: ['low', 'high'], default: 'high' }, configuration: {} },
    { identity: 'preset', runtimeRef: 'lobsterai-server/yd-fast', source: 'subscription', displayName: '快速', providerLabel: 'LobsterAI', available: true,
      image: true, toolCalling: true, thinking: aliasThinking, configuration: {} },
  ];
  const models = new RemoteModelCatalog(remote, () => locals, () => target);
  const preparations = new InputPreparationService({ store, models, cacheRoot: path.join(cwd, 'cache'), getOwner: () => actor,
    getTargetId: () => target, getDefaultModel: () => 'provider/model', getAgentCatalog: () => null });
  const runtime = Object.assign(new EventEmitter(), { patchSession: vi.fn(async (): Promise<void> => undefined) });
  const commands = new SessionCommandService(store, runtime as unknown as CoworkRuntime, () => actor);
  commands.configureInput({ models, preparations, getDeviceId: () => 'pc', getTargetId: () => target });
  const send = vi.fn(async () => { assertRemoteExecutionPermit(); markRemoteExecutionDispatched(); return { success: true }; });
  commands.configure(options => commands.submit(options, true, send), options => commands.submit(options, false, send));
  const summary = commands.recordCurrentInputModel('local');
  const claim: RemotePreparationClaim = { preparationId: 'prep', claimId: 'claim', claimToken: 'token', claimUntil: new Date(Date.now() + 60_000).toISOString(), statusVersion: '1',
    request: { preparationId: 'prep', inputSchemaVersion: 2, purpose: 'send_message', sessionId: 'remote',
      expectedInputVersion: remote.inputVersion('local'), expectedControlVersion: remote.controlVersion('local'),
      input: { text: 'continue', model: { mode: RemoteInputMode.Session } } } };
  const prepare = () => preparations.prepare(owner, 'pc', claim, vi.fn(), () => true);
  const entry = async (): Promise<InboxEntry> => {
    const prepared = await prepare();
    const request = { commandId: 'cmd', type: 'send_message', inputSchemaVersion: 2, sessionId: 'remote',
      expectedInputVersion: claim.request.expectedInputVersion, expectedControlVersion: claim.request.expectedControlVersion,
      payload: { inputPreparationId: prepared.preparationId, inputDigest: prepared.inputDigest, resolvedInput: prepared.resolvedInput } };
    const command = { commandId: 'cmd', type: 'send_message', request, requestHash: payloadHash(request), sessionId: 'remote', runId: 'run',
      status: 'claimed', statusVersion: '1', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    return { targetId: target, command, owner, ...remote.transaction(() => commands.prepare(command, owner, null)), state: 'executing', result: null };
  };
  return { cwd, db, remote, store, locals, preparations, models, runtime, commands, send, summary, claim, prepare, entry,
    switchTarget: () => { target = 'target-b'; }, switchOwner: () => { actor = { userId: 'B', scopeKey: 'personal' }; } };
}
it.each(['high', ''])('continues a preset with its frozen physical thinking (%j) while publishing an empty alias option', async thinking => {
  const f = fixture(thinking);
  expect(f.summary).toMatchObject({ displayName: '快速', thinkingLevel: null });
  const prepared = await f.prepare();
  expect(prepared.resolvedInput.model.modelRef).toBe(f.summary!.modelRef);
  expect(prepared.resolvedInput.options).toEqual({});
  expect(prepared.presetBinding).toMatchObject({ sessionThinkingLevel: thinking || null, thinkingLevel: 'high' });
  const entry = await f.entry();
  await expect(f.commands.execute(entry, () => true)).resolves.toEqual({ outcome: 'started' });
  expect(f.runtime.patchSession).toHaveBeenCalledWith('local', { model: 'provider/model', thinkingLevel: 'high' });
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ modelOverride: 'provider/model', thinkingLevel: 'high' }));
  expect(f.store.getSession('local', 0)).toMatchObject({ modelPresetId: ModelPresetId.Balanced, modelOverride: 'provider/model', thinkingLevel: 'high' });
  expect(f.remote.get(inputOperationKey('cmd', 'target-a'))).toMatchObject({ phase: 'model_applied', presetApplication: { thinkingLevel: 'high' } });
});
it('executes a permitted explicit thinking change exactly and accepts only its own confirmed patch', async () => {
  const f = fixture('high', { options: ['low', 'high'] }); f.claim.request.input.options = { thinkingLevel: 'low' };
  const entry = await f.entry();
  const before = f.preparations.read('prep', owner, 'pc');
  expect(before.resolvedInput.options).toEqual({ thinkingLevel: 'low' });
  await expect(f.commands.execute(entry, () => true)).resolves.toEqual({ outcome: 'started' });
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ modelOverride: 'provider/model', thinkingLevel: 'low' }));
  expect(f.preparations.read('prep', owner, 'pc').presetBinding).toEqual(before.presetBinding);
  f.store.updateSession('local', { thinkingLevel: 'high' });
  expect(() => f.preparations.validate(f.preparations.read('prep', owner, 'pc'), owner, 'pc', true)).toThrow(RemoteInputReason.ModelChanged);
});
it.each(['', 'low'])('rejects explicit thinking %j when the preset does not expose it', async thinkingLevel => {
  const f = fixture(); f.claim.request.input.options = { thinkingLevel };
  await expect(f.prepare()).rejects.toThrow(RemoteInputReason.Invalid); expect(f.send).not.toHaveBeenCalled();
});
it('rejects an alias default conflicting with the actual physical thinking', async () => {
  const f = fixture('high', { options: ['low'], default: 'low' });
  await expect(f.prepare()).rejects.toThrow(RemoteInputReason.ModelChanged);
});
it.each(['preset', 'physical', 'thinking', 'physical-version', 'physical-default', 'alias-version'])('rejects changed %s binding even for a bound command', async change => {
  const f = fixture(); await f.entry(); const prepared = f.preparations.read('prep', owner, 'pc');
  if (change === 'preset') f.store.updateSession('local', { modelPresetId: ModelPresetId.Ultimate });
  else if (change === 'physical') f.store.updateSession('local', { modelOverride: 'provider/other' });
  else if (change === 'thinking') f.store.updateSession('local', { thinkingLevel: 'low' });
  else if (change === 'physical-default') f.locals[0].thinking.default = 'low';
  else f.locals[change === 'alias-version' ? 1 : 0].configuration = { revision: 2 };
  expect(() => f.preparations.validate(prepared, owner, 'pc', true)).toThrow(RemoteInputReason.ModelChanged);
});
it('does not allow alias to physical execution without the private frozen binding', async () => {
  const f = fixture(); const prepared = await f.prepare(); delete prepared.presetBinding;
  expect(() => f.preparations.validate(prepared, owner, 'pc', true)).toThrow(RemoteInputReason.ModelChanged);
});
it.each(['missing', 'hash', 'version', 'command', 'unbound'])('rejects an incomplete or unrelated application proof (%s)', async corrupt => {
  const f = fixture('high', { options: ['low', 'high'] }); f.claim.request.input.options = { thinkingLevel: 'low' };
  const entry = await f.entry(); await f.commands.execute(entry, () => true);
  const key = inputOperationKey('cmd', 'target-a'), proof = f.remote.get<any>(key);
  if (corrupt === 'missing') delete proof.presetApplication;
  else if (corrupt === 'hash') proof.presetApplication.bindingHash = 'wrong';
  else if (corrupt === 'version') proof.afterVersion = '999';
  else if (corrupt === 'command') { f.remote.put(inputOperationKey('other', 'target-a'), proof); f.remote.remove(key); }
  else { const prepared = f.preparations.read('prep', owner, 'pc'); prepared.boundCommandId = null; f.remote.put(`inputPreparation:${JSON.stringify(['target-a', 'prep'])}`, prepared); }
  if (!['command', 'unbound'].includes(corrupt)) f.remote.put(key, proof);
  const prepared = f.preparations.read('prep', owner, 'pc');
  expect(() => f.preparations.validate(prepared, owner, 'pc', true)).toThrow(RemoteInputReason.ModelChanged);
});
it.each(['target', 'owner'])('never sends after %s changes while the physical patch is pending', async change => {
  const f = fixture(); const entry = await f.entry(); let finish!: () => void;
  f.runtime.patchSession.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const execution = f.commands.execute(entry, () => true);
  await vi.waitFor(() => expect(f.runtime.patchSession).toHaveBeenCalledOnce());
  if (change === 'target') f.switchTarget(); else f.switchOwner();
  const failure = expect(execution).rejects.toThrow(); finish(); await failure;
  expect(f.send).not.toHaveBeenCalled();
});
it.each(['preset', 'thinking'])('rejects %s changes while preparation is awaiting its cache directory', async change => {
  const f = fixture(); const pending = f.prepare();
  if (change === 'preset') f.store.updateSession('local', { modelPresetId: ModelPresetId.Ultimate });
  else f.store.updateSession('local', { thinkingLevel: 'low' });
  await expect(pending).rejects.toThrow();
});
