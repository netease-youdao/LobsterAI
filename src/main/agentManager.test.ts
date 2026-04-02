import { test, expect, describe, beforeEach } from 'vitest';
import { AgentManager } from './agentManager';
import { ImportResolutionAction } from './agentConstants';
import type { ExportedAgent, AgentExportEnvelope, ImportResolution } from './agentConstants';
import type { Agent, CoworkStore, CreateAgentRequest, UpdateAgentRequest } from './coworkStore';

// ── Minimal mock CoworkStore ───────────────────────────────────────────────

function makeMockStore(initialAgents: Agent[] = []): CoworkStore {
  const agents = new Map<string, Agent>();
  for (const a of initialAgents) agents.set(a.id, a);

  return {
    listAgents: () => [...agents.values()],
    getAgent: (id: string) => agents.get(id) ?? null,
    createAgent: (req: CreateAgentRequest): Agent => {
      const id = req.id ?? `agent-${Date.now()}`;
      const agent: Agent = {
        id,
        name: req.name,
        description: req.description ?? '',
        systemPrompt: req.systemPrompt ?? '',
        identity: req.identity ?? '',
        model: req.model ?? '',
        icon: req.icon ?? '',
        skillIds: req.skillIds ?? [],
        enabled: true,
        isDefault: false,
        source: req.source ?? 'custom',
        presetId: req.presetId ?? '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      agents.set(id, agent);
      return agent;
    },
    updateAgent: (id: string, updates: UpdateAgentRequest): Agent | null => {
      const existing = agents.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...updates, updatedAt: Date.now() };
      agents.set(id, updated);
      return updated;
    },
    deleteAgent: (id: string): boolean => {
      if (id === 'main') return false;
      return agents.delete(id);
    },
  } as unknown as CoworkStore;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    description: 'A test agent',
    systemPrompt: 'You are a test agent',
    identity: 'test identity',
    model: 'claude-3',
    icon: '🧪',
    skillIds: ['skill-a', 'skill-b'],
    enabled: true,
    isDefault: false,
    source: 'custom',
    presetId: '',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AgentManager.exportAgents', () => {
  test('produces a valid envelope with version 1', () => {
    const agent = makeAgent();
    const store = makeMockStore([agent]);
    const manager = new AgentManager(store);

    const envelope = manager.exportAgents(['test-agent']);

    expect(envelope.version).toBe(1);
    expect(typeof envelope.exportedAt).toBe('string');
    expect(envelope.agents).toHaveLength(1);
  });

  test('strips instance-local fields (enabled, isDefault, createdAt, updatedAt)', () => {
    const agent = makeAgent({ enabled: false, isDefault: true });
    const store = makeMockStore([agent]);
    const manager = new AgentManager(store);

    const envelope = manager.exportAgents(['test-agent']);
    const exported = envelope.agents[0];

    expect(exported).not.toHaveProperty('enabled');
    expect(exported).not.toHaveProperty('isDefault');
    expect(exported).not.toHaveProperty('createdAt');
    expect(exported).not.toHaveProperty('updatedAt');
  });

  test('includes all portable fields', () => {
    const agent = makeAgent();
    const store = makeMockStore([agent]);
    const manager = new AgentManager(store);

    const exported = manager.exportAgents(['test-agent']).agents[0];

    expect(exported.id).toBe('test-agent');
    expect(exported.name).toBe('Test Agent');
    expect(exported.description).toBe('A test agent');
    expect(exported.systemPrompt).toBe('You are a test agent');
    expect(exported.identity).toBe('test identity');
    expect(exported.icon).toBe('🧪');
    expect(exported.skillIds).toEqual(['skill-a', 'skill-b']);
  });

  test('skips non-existent agent IDs', () => {
    const store = makeMockStore([makeAgent()]);
    const manager = new AgentManager(store);

    const envelope = manager.exportAgents(['test-agent', 'nonexistent']);
    expect(envelope.agents).toHaveLength(1);
  });

  test('returns empty agents array when no IDs match', () => {
    const store = makeMockStore([]);
    const manager = new AgentManager(store);

    const envelope = manager.exportAgents(['nonexistent']);
    expect(envelope.agents).toHaveLength(0);
    expect(envelope.version).toBe(1);
  });
});

describe('AgentManager.validateImportFile', () => {
  let manager: AgentManager;
  beforeEach(() => {
    manager = new AgentManager(makeMockStore());
  });

  test('accepts a valid file', () => {
    const content = JSON.stringify({
      version: 1,
      exportedAt: '2026-04-02T00:00:00Z',
      agents: [{ id: 'a1', name: 'Agent 1' }],
    });

    const result = manager.validateImportFile(content);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.envelope.agents).toHaveLength(1);
      expect(result.envelope.agents[0].id).toBe('a1');
    }
  });

  test('rejects invalid JSON', () => {
    const result = manager.validateImportFile('not json');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('Invalid JSON');
  });

  test('rejects missing version', () => {
    const result = manager.validateImportFile(JSON.stringify({ agents: [{ id: 'a', name: 'A' }] }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('version');
  });

  test('rejects wrong version', () => {
    const result = manager.validateImportFile(JSON.stringify({ version: 2, agents: [{ id: 'a', name: 'A' }] }));
    expect(result.valid).toBe(false);
  });

  test('rejects empty agents array', () => {
    const result = manager.validateImportFile(JSON.stringify({ version: 1, agents: [] }));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('no agents');
  });

  test('rejects missing agents key', () => {
    const result = manager.validateImportFile(JSON.stringify({ version: 1 }));
    expect(result.valid).toBe(false);
  });

  test('skips entries missing id', () => {
    const content = JSON.stringify({
      version: 1,
      agents: [
        { name: 'No ID' },
        { id: 'valid', name: 'Valid' },
      ],
    });
    const result = manager.validateImportFile(content);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.envelope.agents).toHaveLength(1);
  });

  test('skips entries missing name', () => {
    const content = JSON.stringify({
      version: 1,
      agents: [
        { id: 'no-name' },
        { id: 'valid', name: 'Valid' },
      ],
    });
    const result = manager.validateImportFile(content);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.envelope.agents).toHaveLength(1);
  });

  test('defaults optional fields', () => {
    const content = JSON.stringify({
      version: 1,
      agents: [{ id: 'minimal', name: 'Minimal' }],
    });
    const result = manager.validateImportFile(content);
    expect(result.valid).toBe(true);
    if (result.valid) {
      const agent = result.envelope.agents[0];
      expect(agent.description).toBe('');
      expect(agent.systemPrompt).toBe('');
      expect(agent.identity).toBe('');
      expect(agent.model).toBe('');
      expect(agent.icon).toBe('');
      expect(agent.skillIds).toEqual([]);
      expect(agent.source).toBe('custom');
      expect(agent.presetId).toBe('');
    }
  });
});

describe('AgentManager.detectConflicts', () => {
  test('no conflicts when no matching IDs', () => {
    const store = makeMockStore([makeAgent({ id: 'existing' })]);
    const manager = new AgentManager(store);

    const envelope: AgentExportEnvelope = {
      version: 1,
      exportedAt: '',
      agents: [{ id: 'new-agent', name: 'New', description: '', systemPrompt: '', identity: '', model: '', icon: '', skillIds: [], source: 'custom', presetId: '' }],
    };

    const { toImport, conflicts } = manager.detectConflicts(envelope);
    expect(toImport).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
  });

  test('detects conflicts for matching IDs', () => {
    const store = makeMockStore([makeAgent({ id: 'clash', name: 'Existing' })]);
    const manager = new AgentManager(store);

    const envelope: AgentExportEnvelope = {
      version: 1,
      exportedAt: '',
      agents: [{ id: 'clash', name: 'Incoming', description: '', systemPrompt: '', identity: '', model: '', icon: '', skillIds: [], source: 'custom', presetId: '' }],
    };

    const { toImport, conflicts } = manager.detectConflicts(envelope);
    expect(toImport).toHaveLength(0);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].existingAgentName).toBe('Existing');
    expect(conflicts[0].incomingAgentName).toBe('Incoming');
  });

  test('splits mixed batch into imports and conflicts', () => {
    const store = makeMockStore([makeAgent({ id: 'existing' })]);
    const manager = new AgentManager(store);

    const makeExported = (id: string, name: string): ExportedAgent => ({
      id, name, description: '', systemPrompt: '', identity: '', model: '', icon: '', skillIds: [], source: 'custom', presetId: '',
    });

    const envelope: AgentExportEnvelope = {
      version: 1,
      exportedAt: '',
      agents: [makeExported('existing', 'E'), makeExported('new1', 'N1'), makeExported('new2', 'N2')],
    };

    const { toImport, conflicts } = manager.detectConflicts(envelope);
    expect(toImport).toHaveLength(2);
    expect(conflicts).toHaveLength(1);
  });

  test('detects main agent as conflict', () => {
    const store = makeMockStore([makeAgent({ id: 'main', name: 'Main', isDefault: true })]);
    const manager = new AgentManager(store);

    const envelope: AgentExportEnvelope = {
      version: 1,
      exportedAt: '',
      agents: [{ id: 'main', name: 'Imported Main', description: '', systemPrompt: '', identity: '', model: '', icon: '', skillIds: [], source: 'custom', presetId: '' }],
    };

    const { conflicts } = manager.detectConflicts(envelope);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe('main');
  });
});

describe('AgentManager.resolveConflicts', () => {
  test('overwrite updates existing agent', () => {
    const store = makeMockStore([makeAgent({ id: 'agent-1', name: 'Old Name' })]);
    const manager = new AgentManager(store);

    const pending = new Map<string, ExportedAgent>();
    pending.set('agent-1', {
      id: 'agent-1', name: 'New Name', description: 'new desc', systemPrompt: 'new prompt',
      identity: '', model: '', icon: '🆕', skillIds: ['s1'], source: 'custom', presetId: '',
    });

    const resolutions: ImportResolution[] = [
      { id: 'agent-1', action: ImportResolutionAction.Overwrite },
    ];

    const { importedCount } = manager.resolveConflicts(resolutions, pending);
    expect(importedCount).toBe(1);

    const updated = store.getAgent('agent-1');
    expect(updated?.name).toBe('New Name');
    expect(updated?.icon).toBe('🆕');
  });

  test('createNew creates agent with new ID', () => {
    const store = makeMockStore([makeAgent({ id: 'agent-1' })]);
    const manager = new AgentManager(store);

    const pending = new Map<string, ExportedAgent>();
    pending.set('agent-1', {
      id: 'agent-1', name: 'Clone', description: '', systemPrompt: '',
      identity: '', model: '', icon: '', skillIds: [], source: 'custom', presetId: '',
    });

    const resolutions: ImportResolution[] = [
      { id: 'agent-1', action: ImportResolutionAction.CreateNew },
    ];

    const { importedCount } = manager.resolveConflicts(resolutions, pending);
    expect(importedCount).toBe(1);

    // Original still exists
    expect(store.getAgent('agent-1')).not.toBeNull();
    // New agent created (ID contains original + timestamp)
    const all = store.listAgents();
    expect(all.length).toBe(2);
    const cloned = all.find(a => a.id !== 'agent-1');
    expect(cloned?.name).toBe('Clone');
    expect(cloned?.id).toMatch(/^agent-1-\d+$/);
  });

  test('skip leaves existing agent unchanged', () => {
    const original = makeAgent({ id: 'agent-1', name: 'Original' });
    const store = makeMockStore([original]);
    const manager = new AgentManager(store);

    const pending = new Map<string, ExportedAgent>();
    pending.set('agent-1', {
      id: 'agent-1', name: 'Should Not Apply', description: '', systemPrompt: '',
      identity: '', model: '', icon: '', skillIds: [], source: 'custom', presetId: '',
    });

    const resolutions: ImportResolution[] = [
      { id: 'agent-1', action: ImportResolutionAction.Skip },
    ];

    const { importedCount } = manager.resolveConflicts(resolutions, pending);
    expect(importedCount).toBe(0);
    expect(store.getAgent('agent-1')?.name).toBe('Original');
  });

  test('handles mixed resolutions', () => {
    const store = makeMockStore([
      makeAgent({ id: 'a1', name: 'A1 Old' }),
      makeAgent({ id: 'a2', name: 'A2 Old' }),
      makeAgent({ id: 'a3', name: 'A3 Old' }),
    ]);
    const manager = new AgentManager(store);

    const makeEx = (id: string, name: string): ExportedAgent => ({
      id, name, description: '', systemPrompt: '', identity: '', model: '', icon: '', skillIds: [], source: 'custom', presetId: '',
    });

    const pending = new Map<string, ExportedAgent>();
    pending.set('a1', makeEx('a1', 'A1 New'));
    pending.set('a2', makeEx('a2', 'A2 Clone'));
    pending.set('a3', makeEx('a3', 'A3 Skip'));

    const resolutions: ImportResolution[] = [
      { id: 'a1', action: ImportResolutionAction.Overwrite },
      { id: 'a2', action: ImportResolutionAction.CreateNew },
      { id: 'a3', action: ImportResolutionAction.Skip },
    ];

    const { importedCount } = manager.resolveConflicts(resolutions, pending);
    expect(importedCount).toBe(2); // overwrite + createNew

    expect(store.getAgent('a1')?.name).toBe('A1 New');
    expect(store.getAgent('a3')?.name).toBe('A3 Old');
    expect(store.listAgents().length).toBe(4); // 3 original + 1 clone
  });
});
