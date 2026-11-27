import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  AgentDraftErrorCode,
  AgentDraftLanguage,
  AgentDraftMode,
  AgentId,
  AgentModelSelectionMode,
  AgentSource,
  SubagentCollaborationMode,
} from '../../shared/agent';
import type { Agent } from '../coworkStore';
import {
  AgentDescriptionBackfillTrigger,
  createAgentDescriptionBackfiller,
  shouldBackfillAgentDescription,
} from './agentDescriptionBackfill';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: '测试 agent',
    description: '',
    systemPrompt: '',
    identity: '',
    model: '',
    modelSelectionMode: AgentModelSelectionMode.Explicit,
    thinkingLevel: '',
    workingDirectory: '',
    icon: '',
    skillIds: [],
    subagentCollaborationMode: SubagentCollaborationMode.All,
    subagentAllowAgentIds: [],
    enabled: true,
    pinned: false,
    isDefault: overrides.id === AgentId.Main,
    source: AgentSource.Custom,
    presetId: '',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shouldBackfillAgentDescription', () => {
  test('triggers when description is empty and rules or folder context exist', () => {
    expect(shouldBackfillAgentDescription({
      trigger: AgentDescriptionBackfillTrigger.Update,
      previousAgent: makeAgent(),
      nextAgent: makeAgent({ systemPrompt: '整理团队周报，先给结论再列细节。' }),
      updates: { systemPrompt: '整理团队周报，先给结论再列细节。', description: '' },
    })).toBe(true);

    expect(shouldBackfillAgentDescription({
      trigger: AgentDescriptionBackfillTrigger.Create,
      previousAgent: null,
      nextAgent: makeAgent({ workingDirectory: '/repo/demo' }),
      hasFolderContext: true,
    })).toBe(true);
  });

  test('skips bare names without rules/context, explicit clears, non-empty descriptions, and pin-only updates', () => {
    // Bare name with no rules and no folder context
    expect(shouldBackfillAgentDescription({
      trigger: AgentDescriptionBackfillTrigger.Create,
      previousAgent: null,
      nextAgent: makeAgent({ name: '测试 agent' }),
      hasFolderContext: false,
    })).toBe(false);

    // User explicitly cleared a previously non-empty description
    expect(shouldBackfillAgentDescription({
      trigger: AgentDescriptionBackfillTrigger.Update,
      previousAgent: makeAgent({ description: '已有简介', systemPrompt: '整理周报' }),
      nextAgent: makeAgent({ description: '', systemPrompt: '整理周报' }),
      updates: { description: '', systemPrompt: '整理周报' },
    })).toBe(false);

    // Non-empty description already present
    expect(shouldBackfillAgentDescription({
      trigger: AgentDescriptionBackfillTrigger.Update,
      previousAgent: makeAgent(),
      nextAgent: makeAgent({ description: '手动填写的简介', systemPrompt: '整理周报' }),
      updates: { description: '手动填写的简介', systemPrompt: '整理周报' },
    })).toBe(false);

    // Pin/sortOrder-only metadata update should not trigger LLM calls
    expect(shouldBackfillAgentDescription({
      trigger: AgentDescriptionBackfillTrigger.Update,
      previousAgent: makeAgent({ systemPrompt: '整理周报' }),
      nextAgent: makeAgent({ systemPrompt: '整理周报', pinned: true }),
      updates: { pinned: true },
    })).toBe(false);
  });
});

describe('createAgentDescriptionBackfiller', () => {
  test('generates summary asynchronously, persists it, syncs config, and notifies windows', async () => {
    const saved = makeAgent({
      id: 'weekly-helper',
      name: '周报助手',
      systemPrompt: '将零散资料整理成结构化周报，先给结论再列细节。',
      updatedAt: 200,
    });
    let currentAgent: Agent | null = saved;
    const updateAgent = vi.fn((_id: string, updates: { description?: string }) => {
      currentAgent = currentAgent ? { ...currentAgent, ...updates, updatedAt: 201 } : null;
      return currentAgent;
    });
    const syncOpenClawConfig = vi.fn().mockResolvedValue({ success: true, changed: true });
    const onAgentDescriptionUpdated = vi.fn();
    const generateAgentDraft = vi.fn().mockResolvedValue({
      success: true as const,
      draft: {
        name: '周报助手',
        description: '将零散资料整理为结论先行的结构化周报',
        instructions: saved.systemPrompt,
        recommendedSkillIds: [],
        starterPrompts: [],
      },
    });

    const backfiller = createAgentDescriptionBackfiller({
      getAgentManager: () => ({
        getAgent: () => currentAgent,
        updateAgent,
      }),
      generateAgentDraft,
      syncOpenClawConfig,
      onAgentDescriptionUpdated,
      getLanguage: () => 'en',
    });

    backfiller.scheduleForUpdatedAgent({
      previousAgent: makeAgent({ id: 'weekly-helper', name: '周报助手' }),
      nextAgent: saved,
      updates: { systemPrompt: saved.systemPrompt, description: '' },
    });

    await vi.waitFor(() => {
      expect(onAgentDescriptionUpdated).toHaveBeenCalledOnce();
    });

    expect(generateAgentDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: AgentDraftMode.Summary,
        name: '周报助手',
        existingInstructions: saved.systemPrompt,
        language: AgentDraftLanguage.Zh,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(updateAgent).toHaveBeenCalledExactlyOnceWith('weekly-helper', {
      description: '将零散资料整理为结论先行的结构化周报',
    });
    expect(syncOpenClawConfig).toHaveBeenCalledExactlyOnceWith({
      reason: 'agent-description-backfilled',
    });
  });

  test('aborts stale write if user edits or fills description before backfill finishes', async () => {
    let resolveDraft!: (value: {
      success: true;
      draft: {
        name: string;
        description: string;
        instructions: string;
        recommendedSkillIds: string[];
        starterPrompts: string[];
      };
    }) => void;
    const saved = makeAgent({
      id: 'reviewer',
      name: 'Reviewer',
      systemPrompt: 'Review pull requests carefully.',
      updatedAt: 300,
    });
    let currentAgent: Agent | null = saved;
    const updateAgent = vi.fn();
    const syncOpenClawConfig = vi.fn().mockResolvedValue({ success: true, changed: false });
    const onAgentDescriptionUpdated = vi.fn();
    let capturedSignal: AbortSignal | undefined;

    const generateAgentDraft = vi.fn((_req, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal;
      return new Promise<Parameters<typeof resolveDraft>[0]>((resolve) => {
        resolveDraft = resolve;
      });
    });

    const backfiller = createAgentDescriptionBackfiller({
      getAgentManager: () => ({
        getAgent: () => currentAgent,
        updateAgent,
      }),
      generateAgentDraft,
      syncOpenClawConfig,
      onAgentDescriptionUpdated,
    });

    backfiller.scheduleForUpdatedAgent({
      previousAgent: makeAgent({ id: 'reviewer', name: 'Reviewer' }),
      nextAgent: saved,
      updates: { systemPrompt: saved.systemPrompt, description: '' },
    });

    expect(capturedSignal?.aborted).toBe(false);

    // User manually sets description while backfill is still in-flight
    currentAgent = { ...saved, description: 'Manual description', updatedAt: 305 };
    backfiller.scheduleForUpdatedAgent({
      previousAgent: saved,
      nextAgent: currentAgent,
      updates: { description: 'Manual description' },
    });
    expect(capturedSignal?.aborted).toBe(true);

    resolveDraft({
      success: true,
      draft: {
        name: 'Reviewer',
        description: 'Auto generated summary',
        instructions: saved.systemPrompt,
        recommendedSkillIds: [],
        starterPrompts: [],
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(updateAgent).not.toHaveBeenCalled();
    expect(onAgentDescriptionUpdated).not.toHaveBeenCalled();
  });

  test('fails silently when no model is available', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const updateAgent = vi.fn();
    const onAgentDescriptionUpdated = vi.fn();
    const saved = makeAgent({ systemPrompt: 'Draft emails cleanly.' });

    const backfiller = createAgentDescriptionBackfiller({
      getAgentManager: () => ({
        getAgent: () => saved,
        updateAgent,
      }),
      generateAgentDraft: vi.fn().mockResolvedValue({
        success: false,
        errorCode: AgentDraftErrorCode.NoModel,
        error: 'No model configured',
      }),
      syncOpenClawConfig: vi.fn().mockResolvedValue({ success: true, changed: false }),
      onAgentDescriptionUpdated,
    });

    backfiller.scheduleForCreatedAgent(saved);
    await vi.waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('no-model'));
    });

    expect(updateAgent).not.toHaveBeenCalled();
    expect(onAgentDescriptionUpdated).not.toHaveBeenCalled();
  });
});
