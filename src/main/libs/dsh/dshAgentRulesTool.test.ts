import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { AgentSource } from '../../../shared/agent/constants';
import {
  AGENT_RULES_LIMITS,
  DSH_AGENT_RULES_TOOL,
  DshAgentRulesAction,
  DshAgentRulesMode,
} from '../../../shared/dshEngine/hostConstants';
import type { Agent, UpdateAgentRequest } from '../../coworkStore';
import { createDshAgentRulesProvider, dshAgentRulesToolDescriptor } from './dshAgentRulesTool';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-weekly',
    name: '周报助手',
    description: '',
    systemPrompt: '',
    identity: '',
    model: '',
    thinkingLevel: '',
    workingDirectory: '',
    icon: '',
    skillIds: [],
    subagentAllowAgentIds: [],
    enabled: true,
    pinned: false,
    pinOrder: null,
    isDefault: false,
    source: AgentSource.Custom,
    presetId: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('createDshAgentRulesProvider', () => {
  test('exposes descriptor scoped to the current agent with no agentId parameter', () => {
    const provider = createDshAgentRulesProvider({
      getAgent: () => null,
      updateAgent: () => null,
      resolveWorkspaceDir: () => '',
    });

    const descriptors = provider.listDescriptors();
    expect(descriptors).toEqual([dshAgentRulesToolDescriptor]);
    expect(dshAgentRulesToolDescriptor.name).toBe(DSH_AGENT_RULES_TOOL);
    const props = dshAgentRulesToolDescriptor.inputSchema.properties as Record<string, unknown>;
    expect(props).not.toHaveProperty('agentId');
    expect(props).toHaveProperty('action');
    expect(props).toHaveProperty('rules');
    expect(props).toHaveProperty('mode');
    expect(props).toHaveProperty('description');
  });

  test('reads disk SOUL.md and IDENTITY.md with fallback to SQLite fields', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-agent-rules-read-'));
    tempDirs.push(root);
    const wsDir = path.join(root, 'agent-weekly');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'SOUL.md'), '- 先给结论\n', 'utf8');

    const agent = makeAgent({
      description: '整理团队周报',
      systemPrompt: 'stale db soul',
      identity: 'fallback identity',
    });

    const provider = createDshAgentRulesProvider({
      getAgent: id => (id === agent.id ? agent : null),
      updateAgent: () => agent,
      resolveWorkspaceDir: id => path.join(root, id),
    });

    const result = await provider.execute(
      DSH_AGENT_RULES_TOOL,
      { action: DshAgentRulesAction.Read },
      { agentId: agent.id },
    ) as { ok: boolean; rules: string; identity: string; description: string; text: string };

    expect(result.ok).toBe(true);
    expect(result.rules).toBe('- 先给结论');
    expect(result.identity).toBe('fallback identity');
    expect(result.description).toBe('整理团队周报');
    expect(result.text).toContain('周报助手');
    expect(result.text).toContain('- 先给结论');
  });

  test('saves rules atomically to the current agent SOUL.md, updates SQLite, and notifies listeners without touching other agents', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-agent-rules-save-'));
    tempDirs.push(root);

    const agents = new Map<string, Agent>([
      ['agent-a', makeAgent({ id: 'agent-a', name: '周报助手' })],
      ['agent-b', makeAgent({ id: 'agent-b', name: '法务助手', systemPrompt: 'Keep legal rules' })],
    ]);
    fs.mkdirSync(path.join(root, 'agent-b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agent-b', 'SOUL.md'), 'Keep legal rules\n', 'utf8');

    const onAgentUpdated = vi.fn();
    const provider = createDshAgentRulesProvider({
      getAgent: id => agents.get(id) ?? null,
      updateAgent: (id, updates: UpdateAgentRequest) => {
        const current = agents.get(id);
        if (!current) return null;
        const next: Agent = {
          ...current,
          ...(updates.systemPrompt !== undefined ? { systemPrompt: updates.systemPrompt } : {}),
          ...(updates.description !== undefined ? { description: updates.description } : {}),
          updatedAt: current.updatedAt + 1,
        };
        agents.set(id, next);
        return next;
      },
      resolveWorkspaceDir: id => path.join(root, id),
      onAgentUpdated,
    });

    // Even if model passes an unexpected agentId arg, context.agentId is the sole authority.
    const res = await provider.execute(
      DSH_AGENT_RULES_TOOL,
      {
        action: DshAgentRulesAction.Save,
        agentId: 'agent-b',
        rules: '- 定位：周报整理助手\n- 风格：先给结论，再列进展与风险',
        description: '  「把零散会议记录整理为结构化周报」 ',
      },
      { agentId: 'agent-a', coworkSessionId: 'session-1' },
    ) as { ok: boolean; agentId: string; description: string; rulesLength: number };

    expect(res.ok).toBe(true);
    expect(res.agentId).toBe('agent-a');
    expect(res.description).toBe('把零散会议记录整理为结构化周报');
    expect(fs.readFileSync(path.join(root, 'agent-a', 'SOUL.md'), 'utf8')).toBe(
      '- 定位：周报整理助手\n- 风格：先给结论，再列进展与风险\n',
    );
    expect(agents.get('agent-a')?.systemPrompt).toBe('- 定位：周报整理助手\n- 风格：先给结论，再列进展与风险');
    expect(agents.get('agent-a')?.description).toBe('把零散会议记录整理为结构化周报');
    // Other agent remains completely isolated.
    expect(fs.readFileSync(path.join(root, 'agent-b', 'SOUL.md'), 'utf8')).toBe('Keep legal rules\n');
    expect(agents.get('agent-b')?.systemPrompt).toBe('Keep legal rules');
    expect(onAgentUpdated).toHaveBeenCalledTimes(1);
    expect(onAgentUpdated).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-a' }));
  });

  test('supports append mode with deduplication and preserves existing description when omitted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-agent-rules-append-'));
    tempDirs.push(root);
    const wsDir = path.join(root, 'agent-weekly');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'SOUL.md'), '- 规则一：先结论后细节\n', 'utf8');

    let stored = makeAgent({
      description: '既有简介',
      systemPrompt: '- 规则一：先结论后细节',
    });

    const provider = createDshAgentRulesProvider({
      getAgent: id => (id === stored.id ? stored : null),
      updateAgent: (_id, updates) => {
        stored = { ...stored, ...updates };
        return stored;
      },
      resolveWorkspaceDir: id => path.join(root, id),
    });

    await provider.execute(
      DSH_AGENT_RULES_TOOL,
      {
        action: DshAgentRulesAction.Save,
        mode: DshAgentRulesMode.Append,
        rules: '- 规则二：待办标明负责人',
      },
      { agentId: stored.id },
    );

    expect(fs.readFileSync(path.join(wsDir, 'SOUL.md'), 'utf8')).toBe(
      '- 规则一：先结论后细节\n\n- 规则二：待办标明负责人\n',
    );
    expect(stored.description).toBe('既有简介');

    // Re-appending an already included block does not duplicate it.
    await provider.execute(
      DSH_AGENT_RULES_TOOL,
      {
        action: DshAgentRulesAction.Save,
        mode: DshAgentRulesMode.Append,
        rules: '- 规则二：待办标明负责人',
      },
      { agentId: stored.id },
    );

    expect(fs.readFileSync(path.join(wsDir, 'SOUL.md'), 'utf8')).toBe(
      '- 规则一：先结论后细节\n\n- 规则二：待办标明负责人\n',
    );
  });

  test('validates missing agent, empty rules, invalid mode/action, and max length', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-agent-rules-err-'));
    tempDirs.push(root);
    const agent = makeAgent();
    const provider = createDshAgentRulesProvider({
      getAgent: id => (id === agent.id ? agent : null),
      updateAgent: () => agent,
      resolveWorkspaceDir: id => path.join(root, id),
    });

    await expect(
      provider.execute(DSH_AGENT_RULES_TOOL, { action: DshAgentRulesAction.Read }, { agentId: 'missing' }),
    ).rejects.toThrow(/not found/);

    await expect(
      provider.execute(DSH_AGENT_RULES_TOOL, { action: 'delete' }, { agentId: agent.id }),
    ).rejects.toThrow(/Unsupported action/);

    await expect(
      provider.execute(DSH_AGENT_RULES_TOOL, { action: DshAgentRulesAction.Save, rules: '   ' }, { agentId: agent.id }),
    ).rejects.toThrow(/non-empty string/);

    await expect(
      provider.execute(
        DSH_AGENT_RULES_TOOL,
        { action: DshAgentRulesAction.Save, rules: 'valid', mode: 'merge' },
        { agentId: agent.id },
      ),
    ).rejects.toThrow(/Invalid mode/);

    await expect(
      provider.execute(
        DSH_AGENT_RULES_TOOL,
        { action: DshAgentRulesAction.Save, rules: 'a'.repeat(AGENT_RULES_LIMITS.MaxRulesChars + 1) },
        { agentId: agent.id },
      ),
    ).rejects.toThrow(/character limit/);
  });
});
