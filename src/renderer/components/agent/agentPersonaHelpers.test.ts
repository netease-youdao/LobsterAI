import { AgentRulePolishDirective, AgentSource } from '@shared/agent';
import { describe, expect, test } from 'vitest';

import {
  AGENT_RULE_POLISH_OPTIONS,
  AGENT_RULE_TEMPLATES,
  AgentCreateAiActionKind,
  AgentRuleTemplateId,
  buildAgentInterviewPrompt,
  buildCreateDraftInputs,
  buildFolderScanSetupPrompt,
  deriveAgentNameFromFolder,
  deriveUnifiedInstructions,
  getPolishDirectiveLabelKey,
  resolveCreateAiActionKind,
  resolveCreateSubmitDescription,
  resolveDescriptionOnAutoFill,
  resolvePersonaFilesOnSave,
  shouldShowAgentQuickSetup,
  UnifiedInstructionSource,
} from './agentPersonaHelpers';

describe('deriveUnifiedInstructions', () => {
  test('prefers soul source when only SOUL.md is populated', () => {
    expect(deriveUnifiedInstructions({ identity: '', systemPrompt: 'Be concise.' })).toEqual({
      text: 'Be concise.',
      source: UnifiedInstructionSource.Soul,
    });
  });

  test('uses identity source when only IDENTITY.md is populated (e.g. main agent)', () => {
    expect(deriveUnifiedInstructions({ identity: 'I am LobsterAI.', systemPrompt: '   ' })).toEqual({
      text: 'I am LobsterAI.',
      source: UnifiedInstructionSource.Identity,
    });
  });

  test('merges both files cleanly when both contain content', () => {
    expect(deriveUnifiedInstructions({ identity: 'Role A', systemPrompt: 'Rule B' })).toEqual({
      text: 'Role A\n\nRule B',
      source: UnifiedInstructionSource.Merged,
    });
  });
});

describe('resolvePersonaFilesOnSave', () => {
  test('preserves original files untouched when neither unified nor raw editors changed', () => {
    expect(resolvePersonaFilesOnSave({
      initialIdentity: 'Old ID',
      initialSystemPrompt: 'Old Soul',
      rawIdentity: 'Old ID',
      rawSystemPrompt: 'Old Soul',
      unifiedText: 'Old ID\n\nOld Soul',
      unifiedSource: UnifiedInstructionSource.Merged,
      unifiedEdited: false,
      rawFilesEdited: false,
    })).toEqual({
      identity: 'Old ID',
      systemPrompt: 'Old Soul',
    });
  });

  test('writes back to IDENTITY.md when main agent originally stored persona there', () => {
    expect(resolvePersonaFilesOnSave({
      initialIdentity: 'Old ID',
      initialSystemPrompt: '',
      rawIdentity: 'Old ID',
      rawSystemPrompt: '',
      unifiedText: 'Updated main identity',
      unifiedSource: UnifiedInstructionSource.Identity,
      unifiedEdited: true,
      rawFilesEdited: false,
    })).toEqual({
      identity: 'Updated main identity',
      systemPrompt: '',
    });
  });

  test('consolidates merged unified edit into SOUL.md and clears IDENTITY.md to avoid duplicate injection', () => {
    expect(resolvePersonaFilesOnSave({
      initialIdentity: 'Old ID',
      initialSystemPrompt: 'Old Soul',
      rawIdentity: 'Old ID',
      rawSystemPrompt: 'Old Soul',
      unifiedText: 'Unified prompt',
      unifiedSource: UnifiedInstructionSource.Merged,
      unifiedEdited: true,
      rawFilesEdited: false,
    })).toEqual({
      identity: '',
      systemPrompt: 'Unified prompt',
    });
  });

  test('respects direct raw file edits when user edited advanced markdown files', () => {
    expect(resolvePersonaFilesOnSave({
      initialIdentity: 'Old ID',
      initialSystemPrompt: 'Old Soul',
      rawIdentity: 'Custom ID',
      rawSystemPrompt: 'Custom Soul',
      unifiedText: 'Ignored unified',
      unifiedSource: UnifiedInstructionSource.Merged,
      unifiedEdited: true,
      rawFilesEdited: true,
    })).toEqual({
      identity: 'Custom ID',
      systemPrompt: 'Custom Soul',
    });
  });
});

describe('deriveAgentNameFromFolder', () => {
  test('fills empty name from folder basename and preserves non-empty user name', () => {
    expect(deriveAgentNameFromFolder('', '/Users/demo/Obsidian Vault/')).toBe('Obsidian Vault');
    expect(deriveAgentNameFromFolder('My Notes', '/Users/demo/Obsidian Vault')).toBe('My Notes');
    expect(deriveAgentNameFromFolder('', '')).toBe('');
  });
});

describe('resolveDescriptionOnAutoFill', () => {
  test('fills empty description from candidate and preserves existing description', () => {
    expect(resolveDescriptionOnAutoFill('', '  整理结构化文档  ')).toEqual({
      nextDescription: '整理结构化文档',
      didFill: true,
    });
    expect(resolveDescriptionOnAutoFill('已有简介', '新候选')).toEqual({
      nextDescription: '已有简介',
      didFill: false,
    });
    expect(resolveDescriptionOnAutoFill('', '   ')).toEqual({
      nextDescription: '',
      didFill: false,
    });
  });
});

describe('rule templates and polish options', () => {
  test('provides unique starter templates with title, description, and content keys', () => {
    const ids = AGENT_RULE_TEMPLATES.map(template => template.id);
    expect(new Set(ids).size).toBe(AGENT_RULE_TEMPLATES.length);
    expect(ids).toContain(AgentRuleTemplateId.GeneralAssistant);
    expect(ids).toContain(AgentRuleTemplateId.CodeCollaborator);
    for (const template of AGENT_RULE_TEMPLATES) {
      expect(template.titleKey).toBeTruthy();
      expect(template.descriptionKey).toBeTruthy();
      expect(template.contentKey).toBeTruthy();
    }
  });

  test('covers every polish directive and resolves its label key', () => {
    const directives = AGENT_RULE_POLISH_OPTIONS.map(option => option.directive);
    expect(directives).toEqual([
      AgentRulePolishDirective.Polish,
      AgentRulePolishDirective.Concise,
      AgentRulePolishDirective.ConclusionFirst,
      AgentRulePolishDirective.Rigorous,
      AgentRulePolishDirective.Friendly,
    ]);
    expect(getPolishDirectiveLabelKey(AgentRulePolishDirective.Concise)).toBe('agentRulePolishConciseTitle');
    expect(getPolishDirectiveLabelKey(AgentRulePolishDirective.Friendly)).toBe('agentRulePolishFriendlyTitle');
  });
});

describe('conversational setup prompt builders', () => {
  test('builds Chinese and English onboarding prompts targeting lobster_agent_rules without touching shared cwd files', () => {
    const zhWithoutFolder = buildAgentInterviewPrompt({
      agentName: '周报助手',
      language: 'zh',
    });
    expect(zhWithoutFolder).toContain('周报助手');
    expect(zhWithoutFolder).not.toContain('工作目录：');
    expect(zhWithoutFolder).toContain('lobster_agent_rules');
    expect(zhWithoutFolder).toContain('AGENTS.md');

    const zh = buildAgentInterviewPrompt({
      agentName: '周报助手',
      workingDirectory: '/Users/demo/reports',
      language: 'zh',
    });
    expect(zh).toContain('周报助手');
    expect(zh).toContain('/Users/demo/reports');
    expect(zh).toContain('lobster_agent_rules');

    const en = buildFolderScanSetupPrompt({
      agentName: 'LobsterAI',
      workingDirectory: '/repo/lobsterai',
      language: 'en',
    });
    expect(en).toContain('LobsterAI');
    expect(en).toContain('/repo/lobsterai');
    expect(en).toContain('lobster_agent_rules');
    expect(en).toContain('AGENTS.md');
  });
});

describe('shouldShowAgentQuickSetup', () => {
  test('shows quick setup only for unconfigured custom agents without starter prompts', () => {
    expect(shouldShowAgentQuickSetup({
      source: AgentSource.Custom,
      systemPrompt: '',
      identity: '   ',
      starterPromptCount: 0,
    })).toBe(true);
  });

  test('hides quick setup once systemPrompt or identity rules are configured', () => {
    expect(shouldShowAgentQuickSetup({
      source: AgentSource.Custom,
      systemPrompt: 'Always reply in concise bullet points.',
      identity: '',
      starterPromptCount: 0,
    })).toBe(false);

    expect(shouldShowAgentQuickSetup({
      source: AgentSource.Custom,
      systemPrompt: '',
      identity: 'Blog publisher assistant',
      starterPromptCount: 0,
    })).toBe(false);
  });

  test('hides quick setup when starter prompts exist or agent is a preset', () => {
    expect(shouldShowAgentQuickSetup({
      source: AgentSource.Custom,
      systemPrompt: '',
      identity: '',
      starterPromptCount: 2,
    })).toBe(false);

    expect(shouldShowAgentQuickSetup({
      source: AgentSource.Preset,
      systemPrompt: '',
      identity: '',
      starterPromptCount: 0,
    })).toBe(false);
  });
});

describe('AgentCreateModal unified prompt helpers', () => {
  test('selects Generate when empty, Regenerate when AI output is untouched, and Refine for user text', () => {
    expect(resolveCreateAiActionKind({
      instructions: '   ',
      isAiOutputUnmodified: false,
    })).toBe(AgentCreateAiActionKind.Generate);

    expect(resolveCreateAiActionKind({
      instructions: '## 定位\n电商运营助手',
      isAiOutputUnmodified: true,
    })).toBe(AgentCreateAiActionKind.Regenerate);

    expect(resolveCreateAiActionKind({
      instructions: '帮我写淘宝标题和活动方案',
      isAiOutputUnmodified: false,
    })).toBe(AgentCreateAiActionKind.Refine);
  });

  test('builds draft inputs preserving user seed across regenerations and refining edited drafts', () => {
    expect(buildCreateDraftInputs({
      actionKind: AgentCreateAiActionKind.Generate,
      name: '电商运营',
      instructions: '',
      workingDirectory: '',
      seedGoal: null,
      hasExistingDraft: false,
    })).toEqual({
      goal: '',
      nextSeedGoal: '',
    });

    expect(buildCreateDraftInputs({
      actionKind: AgentCreateAiActionKind.Refine,
      name: '',
      instructions: '  把视频整理成公众号长文  ',
      workingDirectory: '',
      seedGoal: null,
      hasExistingDraft: false,
    })).toEqual({
      goal: '把视频整理成公众号长文',
      nextSeedGoal: '把视频整理成公众号长文',
    });

    expect(buildCreateDraftInputs({
      actionKind: AgentCreateAiActionKind.Regenerate,
      name: '视频转文章',
      instructions: '## 角色\nAI 生成的初版规则',
      workingDirectory: '',
      seedGoal: '把视频整理成公众号长文',
      hasExistingDraft: true,
    })).toEqual({
      goal: '把视频整理成公众号长文',
      nextSeedGoal: '把视频整理成公众号长文',
    });

    expect(buildCreateDraftInputs({
      actionKind: AgentCreateAiActionKind.Refine,
      name: '电商运营',
      instructions: '## 角色\n用户修改过的规则',
      workingDirectory: '',
      seedGoal: '帮我做店铺日常运营',
      hasExistingDraft: true,
    })).toEqual({
      goal: '帮我做店铺日常运营',
      existingInstructions: '## 角色\n用户修改过的规则',
      nextSeedGoal: '帮我做店铺日常运营',
    });

    expect(buildCreateDraftInputs({
      actionKind: AgentCreateAiActionKind.Regenerate,
      name: '',
      instructions: '仅剩的 AI 规则',
      workingDirectory: '',
      seedGoal: '',
      hasExistingDraft: true,
    })).toEqual({
      goal: '',
      existingInstructions: '仅剩的 AI 规则',
      nextSeedGoal: '',
    });
  });

  test('resolves submit description from AI summary, short single-line goal, or leaves multiline rules for backfill', () => {
    expect(resolveCreateSubmitDescription({
      instructions: '## 角色\n协助店铺日常运营',
      generatedDescription: '  协助店铺日常运营与数据复盘  ',
    })).toBe('协助店铺日常运营与数据复盘');

    expect(resolveCreateSubmitDescription({
      instructions: '把视频整理成通俗的公众号长文，重点提炼案例',
      generatedDescription: null,
    })).toBe('把视频整理成通俗的公众号长文，重点提炼案例');

    expect(resolveCreateSubmitDescription({
      instructions: '## 定位\n电商运营助手\n- 先给结论',
      generatedDescription: null,
    })).toBe('');

    expect(resolveCreateSubmitDescription({
      instructions: 'a'.repeat(121),
      generatedDescription: null,
    })).toBe('');

    expect(resolveCreateSubmitDescription({
      instructions: '   ',
      generatedDescription: '不应保留的旧简介',
    })).toBe('');
  });
});
