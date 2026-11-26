import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { AgentSettingsService } from './service';
import { AgentSettingsFileStore, readSettingsDocument } from './storage';
import {
  type AgentSettingsAgent, type AgentSettingsContext, type AgentSettingsDependencies, AgentSettingsError,
  AgentSettingsReason, AgentSettingsSection,
} from './types';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const temporary = (): string => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agent-settings-test-')); directories.push(dir); return dir;
};
function fixture(overrides: Partial<AgentSettingsDependencies> = {}) {
  const root = temporary(), values = new Map<string, unknown>();
  const context: AgentSettingsContext = { owner: { userId: 'user1', scopeKey: 'personal' }, deviceId: 'desktop1', agentId: 'agent1',
    dataSpaceId: 'space1', dataGeneration: '1', accountEpoch: '1', source: 'app', bindingId: 'binding1', bindingVersion: '1' };
  let agent: AgentSettingsAgent = { id: 'agent1', enabled: true, model: 'provider/old', thinkingLevel: '', identity: 'old identity', subagentAllowAgentIds: [], updatedAt: 1 };
  let authorized = true;
  const lease = { assertCurrent: vi.fn(), release: vi.fn() };
  const deps: AgentSettingsDependencies = {
    stateDir: root,
    store: { get: <T>(key: string) => structuredClone(values.get(key) ?? null) as T | null, set: (key, value) => { values.set(key, structuredClone(value)); } },
    assertAccess: () => { if (!authorized) throw new AgentSettingsError('SETTINGS_ACCESS_REVOKED'); },
    getAgent: () => ({ ...agent, subagentAllowAgentIds: [...agent.subagentAllowAgentIds] }),
    updateAgent: (_context, patch) => { agent = { ...agent, ...patch, updatedAt: (agent.updatedAt ?? 0) + 1 }; },
    readModel: (_context, current) => ({ modelRef: current.model === 'provider/new' ? 'new' : 'old', modelVersion: '1', thinkingLevel: current.thinkingLevel || null,
      inherited: false, selectionState: 'available', unavailableReason: null }),
    resolveModel: (_context, selection) => ({ model: `provider/${selection.modelRef}`, thinkingLevel: selection.thinkingLevel ?? '' }),
    listCollaborators: () => [{ agentId: 'main', agentVersion: '1', name: 'Main', icon: null }],
    acquireWriteLease: async () => lease,
    confirmApplied: async () => undefined,
    authorizeConversation: async () => undefined,
    ...overrides,
  };
  const service = new AgentSettingsService(deps);
  const conversation = { ...context, source: 'conversation' as const, commandId: 'command1', runId: 'run1', toolCallId: 'tool1' };
  const file = (agentId: string, filename: string, content: string) => {
    const dir = path.join(root, `workspace-${agentId}`); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, filename), content); return path.join(dir, filename);
  };
  return { root, context, conversation, service, deps, file, lease, values, getAgent: () => agent,
    revoke: () => { authorized = false; }, setAgent: (patch: Partial<AgentSettingsAgent>) => { agent = { ...agent, ...patch }; } };
}
const permit = async () => ({ permitId: 'permit1', startBefore: Date.now() + 5000 });

describe('AgentSettingsService', () => {
  test('reads each Agent MEMORY independently; missing never falls back to main', async () => {
    const f = fixture(); f.file('main', 'MEMORY.md', 'private main memory');
    const missing = await f.service.read(f.context, AgentSettingsSection.Memory);
    expect(missing.value).toEqual({ text: '' }); expect(missing.documentState).toBe('missing');
    f.file('agent1', 'MEMORY.md', 'agent one');
    const own = await f.service.read(f.context, AgentSettingsSection.Memory);
    expect(own.value).toEqual({ text: 'agent one' }); expect(own.revision).not.toBe(missing.revision);
    expect((await f.service.read(f.context, AgentSettingsSection.Memory)).revision).toBe(own.revision);
  });
  test('reads non-main identity from SQLite, not the possibly stale projection', async () => {
    const f = fixture(); f.file('agent1', 'IDENTITY.md', 'stale projection');
    expect((await f.service.read(f.context, AgentSettingsSection.Identity)).value).toEqual({ text: 'old identity' });
  });
  test('keeps memory revisions independent of a USER file update and scopes them by account epoch', async () => {
    const f = fixture(); f.file('agent1', 'MEMORY.md', 'remember');
    const before = await f.service.read(f.context, AgentSettingsSection.Memory);
    f.file('agent1', 'USER.md', 'profile');
    expect((await f.service.read(f.context, AgentSettingsSection.Memory)).revision).toBe(before.revision);
    expect((await f.service.read({ ...f.context, accountEpoch: '2' }, AgentSettingsSection.Memory)).revision).not.toBe(before.revision);
  });
  test('rejects text app updates, oversized content and missing trusted conversation proof', async () => {
    const f = fixture({ authorizeConversation: undefined });
    const { revision } = await f.service.read(f.context, AgentSettingsSection.Memory);
    const proposal = { operationId: 'op1', section: AgentSettingsSection.Memory, expectedRevision: revision, changeKind: 'replace_all' as const, value: { text: 'new' } };
    await expect(f.service.prepare(f.context, proposal)).rejects.toMatchObject({ reason: AgentSettingsReason.DirectEdit });
    await expect(f.service.prepare(f.conversation, proposal)).rejects.toMatchObject({ reason: AgentSettingsReason.Conversation });
    await expect(f.service.prepare(f.conversation, { ...proposal, value: { text: '界'.repeat(30000) } })).rejects.toMatchObject({ reason: AgentSettingsReason.TooLarge });
  });
  test('journals before permit, applies a model once and preserves explicit session data by only patching Agent fields', async () => {
    const f = fixture(), original = await f.service.read(f.context, AgentSettingsSection.Model);
    const prepared = await f.service.prepare(f.context, { operationId: 'op1', section: AgentSettingsSection.Model, expectedRevision: original.revision,
      value: { modelRef: 'new', modelVersion: '1', thinkingLevel: null } });
    expect(prepared.status).toBe('prepared'); expect(f.getAgent().model).toBe('provider/old');
    const callback = vi.fn(async () => { expect(JSON.stringify([...f.values.values()])).toContain('provider/new'); return permit(); });
    const applied = await f.service.apply(f.context, 'op1', callback);
    expect(applied.status).toBe('applied'); expect(f.getAgent().model).toBe('provider/new'); expect(f.lease.release).toHaveBeenCalledOnce();
    expect(await f.service.apply(f.context, 'op1', callback)).toEqual(applied); expect(callback).toHaveBeenCalledOnce();
  });
  test('detects external change after read and prevents hidden collaborator replacement', async () => {
    const f = fixture(); const before = await f.service.read(f.context, AgentSettingsSection.Collaboration);
    f.setAgent({ subagentAllowAgentIds: ['hidden-agent'] });
    const current = await f.service.read(f.context, AgentSettingsSection.Collaboration);
    expect(current.value.selected).toEqual([]); expect(current.value.requiresLocalCleanup).toBe(true);
    await expect(f.service.prepare(f.context, { operationId: 'op1', section: AgentSettingsSection.Collaboration, expectedRevision: before.revision, value: { selected: [] } }))
      .rejects.toMatchObject({ reason: AgentSettingsReason.Conflict });
    await expect(f.service.prepare(f.context, { operationId: 'op1', section: AgentSettingsSection.Collaboration, expectedRevision: current.revision, value: { selected: [] } }))
      .rejects.toMatchObject({ reason: AgentSettingsReason.Cleanup });
  });
  test('clears both non-main SQLite identity and its projection under a trusted conversation lease', async () => {
    const f = fixture(); const file = f.file('agent1', 'IDENTITY.md', 'old identity\n');
    const current = await f.service.read(f.conversation, AgentSettingsSection.Identity);
    await f.service.prepare(f.conversation, { operationId: 'op1', section: AgentSettingsSection.Identity, expectedRevision: current.revision, changeKind: 'clear', value: { text: '' } });
    expect((await f.service.apply(f.conversation, 'op1', permit)).status).toBe('applied');
    expect(f.getAgent().identity).toBe(''); expect(fs.readFileSync(file, 'utf8')).toBe('');
  });
  test('accepts a maximum-sized SQLite identity plus its projection newline', async () => {
    const f = fixture(), current = await f.service.read(f.context, AgentSettingsSection.Identity), text = 'x'.repeat(16 * 1024);
    await f.service.prepare(f.conversation, { operationId: 'op1', section: AgentSettingsSection.Identity, expectedRevision: current.revision, changeKind: 'replace_all', value: { text } });
    expect((await f.service.apply(f.conversation, 'op1', permit)).status).toBe('applied');
    expect((await f.service.read(f.context, AgentSettingsSection.Identity)).value).toEqual({ text });
  });
  test('requires real writer coordination and checks revoked access after permit', async () => {
    const f = fixture(); const current = await f.service.read(f.context, AgentSettingsSection.Model);
    await f.service.prepare(f.context, { operationId: 'op1', section: AgentSettingsSection.Model, expectedRevision: current.revision,
      value: { modelRef: 'new', modelVersion: '1', thinkingLevel: null } });
    await expect(f.service.apply(f.context, 'op1', async () => { f.revoke(); return permit(); })).rejects.toThrow('SETTINGS_ACCESS_REVOKED');
    expect(f.getAgent().model).toBe('provider/old'); expect(f.lease.release).toHaveBeenCalledOnce();
  });
  test('revalidates the target model after the permit network round trip', async () => {
    let available = true;
    const f = fixture({ resolveModel: () => { if (!available) throw new AgentSettingsError('MODEL_VERSION_CONFLICT'); return { model: 'provider/new', thinkingLevel: '' }; } });
    const initial = await f.service.read(f.context, AgentSettingsSection.Model);
    await f.service.prepare(f.context, { operationId: 'op1', section: AgentSettingsSection.Model, expectedRevision: initial.revision, value: { modelRef: 'new', modelVersion: '1', thinkingLevel: null } });
    await expect(f.service.apply(f.context, 'op1', async () => { available = false; return permit(); })).rejects.toThrow('MODEL_VERSION_CONFLICT');
    expect(f.getAgent().model).toBe('provider/old');
  });
  test('does not request another permit after a lost response', async () => {
    const f = fixture(); const current = await f.service.read(f.context, AgentSettingsSection.Model);
    await f.service.prepare(f.context, { operationId: 'op1', section: AgentSettingsSection.Model, expectedRevision: current.revision,
      value: { modelRef: 'new', modelVersion: '1', thinkingLevel: null } });
    await expect(f.service.apply(f.context, 'op1', async () => { throw new Error('lost response'); })).rejects.toThrow('lost response');
    const callback = vi.fn(permit);
    expect((await f.service.apply(f.context, 'op1', callback)).status).toBe('reconciling'); expect(callback).not.toHaveBeenCalled();
    expect((await new AgentSettingsService(f.deps).recover(f.context, 'op1')).status).toBe('reconciling');
  });
  test('recovers a persisted write after config confirmation failed without writing a second time', async () => {
    const confirm = vi.fn().mockRejectedValueOnce(new Error('sync unavailable')).mockResolvedValue(undefined);
    const f = fixture({ confirmApplied: confirm }); const current = await f.service.read(f.context, AgentSettingsSection.Model);
    await f.service.prepare(f.context, { operationId: 'op1', section: AgentSettingsSection.Model, expectedRevision: current.revision,
      value: { modelRef: 'new', modelVersion: '1', thinkingLevel: null } });
    await expect(f.service.apply(f.context, 'op1', permit)).rejects.toThrow('sync unavailable');
    const updatedAt = f.getAgent().updatedAt;
    expect((await new AgentSettingsService(f.deps).recover(f.context, 'op1')).status).toBe('applied');
    expect(f.getAgent().updatedAt).toBe(updatedAt);
  });
  test('confirms a persisted conversation write after run termination and binding revocation without another mutation', async () => {
    const confirm = vi.fn().mockRejectedValueOnce(new Error('pending')).mockResolvedValue(undefined);
    const recoveryLease = vi.fn(async () => ({ assertCurrent: () => undefined, release: () => undefined }));
    const f = fixture({ confirmApplied: confirm, assertRecoveryAccess: () => undefined,
      assertRecoverySourceAccess: () => undefined, acquireRecoveryLease: recoveryLease });
    f.file('agent1', 'MEMORY.md', 'before');
    const snapshot = await f.service.read(f.context, AgentSettingsSection.Memory);
    await f.service.prepare(f.conversation, { operationId: 'op1', section: AgentSettingsSection.Memory, expectedRevision: snapshot.revision, changeKind: 'append', value: { text: 'before after' } });
    await expect(f.service.apply(f.conversation, 'op1', permit)).rejects.toThrow('pending');
    f.revoke(); f.deps.acquireWriteLease = async () => { throw new Error('CONVERSATION_SOURCE_INVALID'); };
    expect((await new AgentSettingsService(f.deps).recover(f.conversation, 'op1')).status).toBe('applied');
    expect(recoveryLease).toHaveBeenCalledOnce(); expect(fs.readFileSync(path.join(f.root, 'workspace-agent1/MEMORY.md'), 'utf8')).toBe('before after');
  });
  test('does not ask approval for no change and still obtains a permit for an unchanged direct save', async () => {
    const authorize = vi.fn(async () => undefined), f = fixture({ authorizeConversation: authorize });
    const memory = await f.service.read(f.context, AgentSettingsSection.Memory);
    const unchanged = await f.service.prepare(f.conversation, { operationId: 'noop', section: AgentSettingsSection.Memory, expectedRevision: memory.revision, changeKind: 'append', value: { text: '' } });
    expect(unchanged.status).toBe('no_change'); expect(authorize).not.toHaveBeenCalled();
    const model = await f.service.read(f.context, AgentSettingsSection.Model), updatedAt = f.getAgent().updatedAt;
    await f.service.prepare(f.context, { operationId: 'op1', section: AgentSettingsSection.Model, expectedRevision: model.revision, value: { modelRef: 'old', modelVersion: '1', thinkingLevel: null } });
    const callback = vi.fn(permit); expect((await f.service.apply(f.context, 'op1', callback)).status).toBe('applied');
    expect(callback).toHaveBeenCalledOnce(); expect(f.getAgent().updatedAt).toBe(updatedAt);
  });
  test('cancels prepared intent after revoked binding, but cannot guess an attempted permit was unused', async () => {
    const f = fixture({ assertRecoveryAccess: () => undefined });
    const model = await f.service.read(f.context, AgentSettingsSection.Model);
    await f.service.prepare(f.context, { operationId: 'op1', section: AgentSettingsSection.Model, expectedRevision: model.revision, value: { modelRef: 'new', modelVersion: '1', thinkingLevel: null } });
    f.revoke();
    expect((await f.service.cancelPrepared(f.context, 'op1')).status).toBe('rejected');
    expect((await f.service.recover(f.context, 'op1')).status).toBe('rejected');
    expect(f.getAgent().model).toBe('provider/old');
  });
  test('keeps the physical partition fenced across account epochs and process restarts', async () => {
    const f = fixture(), initial = await f.service.read(f.context, AgentSettingsSection.Model);
    const value = { modelRef: 'new', modelVersion: '1', thinkingLevel: null };
    await f.service.prepare(f.context, { operationId: 'op1', section: AgentSettingsSection.Model, expectedRevision: initial.revision, value });
    const newer = { ...f.context, accountEpoch: '2' }, restarted = new AgentSettingsService(f.deps);
    const current = await restarted.read(newer, AgentSettingsSection.Model);
    const proposal = { operationId: 'op2', section: AgentSettingsSection.Model, expectedRevision: current.revision, value };
    await expect(restarted.prepare(newer, proposal)).rejects.toMatchObject({ reason: AgentSettingsReason.Pending });
    await restarted.cancelPrepared(f.context, 'op1');
    expect((await restarted.prepare(newer, proposal)).status).toBe('prepared');
  });
  test('validates exact selection boundaries before requesting approval', async () => {
    const authorize = vi.fn(async () => undefined), f = fixture({ authorizeConversation: authorize }); f.file('agent1', 'MEMORY.md', 'abc');
    const memory = await f.service.read(f.context, AgentSettingsSection.Memory);
    await expect(f.service.prepare(f.conversation, { operationId: 'op1', section: AgentSettingsSection.Memory, expectedRevision: memory.revision, changeKind: 'replace_selection', selection: { start: 1, end: 2, expectedText: 'b' }, value: { text: 'bad' } })).rejects.toMatchObject({ reason: AgentSettingsReason.Invalid });
    expect(authorize).not.toHaveBeenCalled();
  });
  test('does not treat external content matching a candidate as our successful write', async () => {
    const f = fixture(); const current = await f.service.read(f.context, AgentSettingsSection.Model);
    await f.service.prepare(f.context, { operationId: 'op1', section: AgentSettingsSection.Model, expectedRevision: current.revision,
      value: { modelRef: 'new', modelVersion: '1', thinkingLevel: null } });
    await expect(f.service.apply(f.context, 'op1', async () => { throw new Error('lost'); })).rejects.toThrow();
    f.setAgent({ model: 'provider/new' });
    expect((await f.service.recover(f.context, 'op1')).status).toBe('reconciling');
  });
});

describe('safe settings storage', () => {
  test('rejects file links, directory links, non-files, invalid UTF-8 and oversized reads', () => {
    const root = temporary(), target = path.join(root, 'real'); fs.writeFileSync(target, 'secret');
    fs.symlinkSync(target, path.join(root, 'link'));
    expect(() => readSettingsDocument(path.join(root, 'link'), 100)).toThrow(AgentSettingsError);
    fs.symlinkSync(root, path.join(root, 'dirlink'));
    expect(() => readSettingsDocument(path.join(root, 'dirlink', 'real'), 100)).toThrow(AgentSettingsError);
    expect(() => readSettingsDocument(root, 100)).toThrow(AgentSettingsError);
    expect(() => readSettingsDocument(target, 2)).toThrow(AgentSettingsReason.TooLarge);
    fs.writeFileSync(target, Buffer.from([0xff])); expect(() => readSettingsDocument(target, 100)).toThrow(AgentSettingsReason.LocalAction);
  });
  test('persists encrypted journal across instances and fails closed on corruption', () => {
    const root = temporary(), key = randomBytes(32);
    const protection = {
      encryptString: (text: string) => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
      decryptString: (data: Buffer) => { const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'); },
    };
    new AgentSettingsFileStore(root, protection).set('journal', { text: 'sensitive memory' });
    const file = path.join(root, fs.readdirSync(root)[0]);
    expect(fs.readFileSync(file).includes(Buffer.from('sensitive memory'))).toBe(false);
    expect(new AgentSettingsFileStore(root, protection).get('journal')).toEqual({ text: 'sensitive memory' });
    fs.writeFileSync(file, 'corrupt'); expect(() => new AgentSettingsFileStore(root, protection).get('journal')).toThrow(AgentSettingsError);
  });
});
