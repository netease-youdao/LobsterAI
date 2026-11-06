import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { AgentSource } from '../../../shared/agent/constants';
import { AgentManager } from '../../agentManager';
import type { Agent } from '../../coworkStore';
import { RemoteModelCatalog } from '../../remote/remoteModelCatalog';
import { AgentSettingsRuntimeBridge } from '../agentSettingsConversation/runtime';
import { type AgentSettingsFactoryOptions, createAgentSettingsService } from './factory';
import { isSettingsEncryptionAvailable } from './storage';
import { type AgentSettingsContext,AgentSettingsReason, AgentSettingsSection } from './types';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agent-settings-factory-')); roots.push(root);
  const owner = { userId: 'owner', scopeKey: 'scope' };
  const context: AgentSettingsContext = { owner, dataSpaceId: 'space', dataGeneration: '1', deviceId: 'device', agentId: 'agent', accountEpoch: '1', source: 'app' };
  const rows = new Map<string, Agent>();
  for (const id of ['agent', 'main', 'anonymous']) rows.set(id, { id, name: id, enabled: true, model: '', thinkingLevel: '', identity: 'private identity', source: AgentSource.Custom,
    subagentAllowAgentIds: [], updatedAt: 1 } as Agent);
  const store = {
    getAgent: (id: string) => rows.get(id) ?? null,
    assertAgentAccess: (id: string) => { if (!rows.has(id)) throw new Error('AGENT_UNAVAILABLE'); },
    updateAgent: vi.fn((id: string, patch: Partial<Agent>) => { const value = { ...rows.get(id)!, ...patch, updatedAt: 2 }; rows.set(id, value); return value; }),
    agentOwnership: { canPublish: (id: string) => id !== 'anonymous', get: () => ({ version: '1' }) },
  };
  const catalog = new Map<string, unknown>();
  const models = new RemoteModelCatalog({ get: <T>(key: string) => catalog.get(key) as T | null, put: (key: string, value: unknown) => { catalog.set(key, value); } }, () => [{
    identity: 'one', runtimeRef: 'private-provider/secret-model', source: 'custom', displayName: 'Safe model', providerLabel: 'Custom',
    available: true, image: false, toolCalling: true, thinking: { options: ['off', 'low'], default: 'low' }, configuration: { apiKey: 'private-key' },
  }]);
  let defaultModel = 'private-provider/secret-model', granted = true, encryption = true;
  const key = randomBytes(32);
  const sync = vi.fn(async () => undefined);
  const options: AgentSettingsFactoryOptions = {
    stateDir: root, journalDir: path.join(root, 'journal'), store: store as unknown as AgentSettingsFactoryOptions['store'], models,
    agents: { captureOwner: () => owner, listAgents: () => [...rows.values()] } as unknown as AgentSettingsFactoryOptions['agents'],
    runtime: { ready: async () => true, acquireWriteLease: async () => ({ assertCurrent: () => undefined, release: () => undefined }) },
    protection: {
      isEncryptionAvailable: () => encryption,
      encryptString: text => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
      decryptString: data => { const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(-16)); return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString('utf8'); },
    },
    access: () => ({ assertAccess: () => { if (!granted) throw new Error('SETTINGS_ACCESS_REQUIRED'); }, assertRecoveryAccess: () => undefined }),
    getDefaultModel: () => defaultModel, authorizeConversation: async () => undefined, syncAndConfirmConfig: sync,
  };
  return { core: createAgentSettingsService(options), context, models, rows, store, sync, root,
    setDefault: (value: string) => { defaultModel = value; }, revoke: () => { granted = false; }, noEncryption: () => { encryption = false; } };
}

test('maps inherited defaults safely and allows repair of an unavailable default', async () => {
  const f = setup(), initial = await f.core.service.read(f.context, AgentSettingsSection.Model);
  expect(initial.value).toMatchObject({ inherited: true, selectionState: 'available', thinkingLevel: 'low' });
  f.setDefault('deleted/private-endpoint');
  const broken = await f.core.service.read(f.context, AgentSettingsSection.Model);
  expect(broken.value).toMatchObject({ modelRef: null, modelVersion: null, selectionState: 'unavailable' });
  expect(JSON.stringify(broken)).not.toContain('private'); expect(broken.revision).not.toBe(initial.revision);
  const model = f.models.refresh(f.context.owner, f.context.deviceId)[0];
  await f.core.service.prepare(f.context, { operationId: 'repair', section: AgentSettingsSection.Model, expectedRevision: broken.revision,
    value: { modelRef: model.modelRef, modelVersion: model.version, thinkingLevel: null } });
  expect((await f.core.service.apply(f.context, 'repair', async () => ({ permitId: 'permit', startBefore: Date.now() + 5000 }))).status).toBe('applied');
  expect(f.rows.get('agent')?.model).toBe('private-provider/secret-model'); expect(f.sync).toHaveBeenCalledOnce();
});

test('keeps preset identity read-only and never adopts anonymous Agents', async () => {
  const f = setup(); f.rows.get('agent')!.source = AgentSource.Preset;
  const identity = await f.core.service.read(f.context, AgentSettingsSection.Identity);
  await expect(f.core.service.prepare({ ...f.context, source: 'conversation', commandId: 'command', runId: 'run', toolCallId: 'tool' }, {
    operationId: 'write', section: AgentSettingsSection.Identity, expectedRevision: identity.revision, changeKind: 'clear', value: { text: '' },
  })).rejects.toMatchObject({ reason: AgentSettingsReason.LocalAction });
  await expect(f.core.service.read({ ...f.context, agentId: 'anonymous' }, AgentSettingsSection.Identity)).rejects.toMatchObject({ reason: AgentSettingsReason.Agent });
  expect(f.core.listAgents().map(agent => agent.agentId)).toEqual(['agent', 'main']);
});

test('includes the shared main as an eligible collaborator and hides all selections on cleanup', async () => {
  const f = setup(); f.rows.get('agent')!.subagentAllowAgentIds = ['main', 'anonymous'];
  const snapshot = await f.core.service.read(f.context, AgentSettingsSection.Collaboration);
  expect(snapshot.value).toMatchObject({ selected: [], requiresLocalCleanup: true });
  expect(snapshot.value.candidates).toEqual([{ agentId: 'main', agentVersion: '1', name: 'main', icon: null }]);
});

test('requires explicit binding even for shared main and withholds availability without encryption', async () => {
  const f = setup(); expect(await f.core.refreshAvailability()).toBe(true);
  f.revoke();
  await expect(f.core.service.read({ ...f.context, agentId: 'main' }, AgentSettingsSection.Memory)).rejects.toThrow('SETTINGS_ACCESS_REQUIRED');
  f.noEncryption(); expect(f.core.available()).toBe(false);
  expect(f.store.updateAgent).not.toHaveBeenCalled();
});

test('existing local Agent update and deletion are blocked only while the gateway write lease is held', async () => {
  const f = setup();
  const store = f.store as unknown as AgentSettingsFactoryOptions['store'];
  const manager = new AgentManager(store, async () => { throw new Error('unused'); }, () => f.context.owner);
  const gateway = { request: async <T>(): Promise<T> => ({ token: 'lease', expiresAt: Date.now() + 5000 }) as T };
  const runtime = new AgentSettingsRuntimeBridge({ store, gateway: () => gateway, owner: () => f.context.owner, epoch: () => 1,
    resolveSession: () => undefined, currentRun: () => false, otherRuns: () => false, approval: () => null });
  const lease = await runtime.acquireWriteLease(f.context);
  try {
    expect(() => manager.updateAgent('agent', { model: 'new' })).toThrow('SETTINGS_OPERATION_PENDING');
    expect(() => manager.deleteAgent('agent')).toThrow('SETTINGS_OPERATION_PENDING');
    expect(f.store.updateAgent).not.toHaveBeenCalled();
  } finally { lease.release(); }
  expect(manager.updateAgent('agent', { model: 'new' })?.model).toBe('new');
});

test('Linux basic-text and unknown key stores cannot enable protected settings', () => {
  for (const backend of ['basic_text', 'unknown']) expect(isSettingsEncryptionAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend }, 'linux')).toBe(false);
  expect(isSettingsEncryptionAvailable({ isEncryptionAvailable: () => true }, 'linux')).toBe(false);
  expect(isSettingsEncryptionAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'kwallet6' }, 'linux')).toBe(true);
});
