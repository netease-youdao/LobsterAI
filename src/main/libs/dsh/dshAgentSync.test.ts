import { describe, expect, test } from 'vitest';

import {
  AgentId,
  AgentModelSelectionMode,
  AgentSource,
  SubagentCollaborationMode,
} from '../../../shared/agent/constants';
import { DshProgressiveCapability } from '../../../shared/dshEngine/hostConstants';
import type { Agent } from '../../coworkStore';
import {
  buildDshHostAgentSpecs,
  resolveAllowedSkillIdsForTurn,
  resolveHostCapabilitiesForAgent,
} from './dshAgentSync';

function makeAgent(overrides: Partial<Agent> & { id: string; name: string }): Agent {
  return {
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
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('buildDshHostAgentSpecs', () => {
  test('translates collaboration modes, deduplicates allowAgentIds, and scopes skills', () => {
    const agents: Agent[] = [
      makeAgent({
        id: AgentId.Main,
        name: '主 Agent',
        description: '默认助手',
        skillIds: ['ignored-for-main'],
        subagentCollaborationMode: SubagentCollaborationMode.All,
      }),
      makeAgent({
        id: 'translator',
        name: '翻译专家',
        description: '负责中英文文章翻译',
        model: 'openai/gpt-5',
        modelSelectionMode: AgentModelSelectionMode.Inherit,
        skillIds: ['baoyu-post-to-wechat'],
        subagentCollaborationMode: SubagentCollaborationMode.Allowlist,
        subagentAllowAgentIds: ['translator', 'blog-publisher', 'blog-publisher', '  '],
      }),
      makeAgent({
        id: 'blog-publisher',
        name: '博客自动发布',
        description: '发布 Markdown 到 Hugo 博客仓库',
        systemPrompt: '你是博客发布助手',
        model: 'anthropic/claude-sonnet-4',
        thinkingLevel: 'high',
        workingDirectory: '/Users/dev/blog',
        skillIds: ['hugo-publish', 'disabled-skill'],
        subagentCollaborationMode: SubagentCollaborationMode.Disabled,
      }),
    ];

    const skills = [
      { id: 'baoyu-post-to-wechat', name: '微信公众号发布', description: '发布到公众号', enabled: true },
      { id: 'hugo-publish', name: 'Hugo 博客发布', description: '推送博客仓库', enabled: true },
      { id: 'disabled-skill', name: '已禁用技能', description: '不可用', enabled: false },
    ];

    const specs = buildDshHostAgentSpecs({
      agents,
      skills,
      resolveExplicitModel: (agent) => {
        const [provider, model] = agent.model.split('/');
        return provider && model
          ? { provider, model, ...(agent.thinkingLevel ? { reasoningEffort: agent.thinkingLevel } : {}) }
          : null;
      },
    });

    expect(specs).toEqual([
      {
        id: 'main',
        name: '主 Agent',
        description: '默认助手',
        enabled: true,
        allowedSkillIds: null,
        collaborationMode: SubagentCollaborationMode.All,
        allowAgentIds: [],
      },
      {
        id: 'translator',
        name: '翻译专家',
        description: '负责中英文文章翻译',
        enabled: true,
        allowedSkillIds: ['baoyu-post-to-wechat'],
        collaborationMode: SubagentCollaborationMode.Allowlist,
        allowAgentIds: ['blog-publisher'],
        skillSummaries: [
          { id: 'baoyu-post-to-wechat', name: '微信公众号发布', description: '发布到公众号' },
        ],
      },
      {
        id: 'blog-publisher',
        name: '博客自动发布',
        description: '发布 Markdown 到 Hugo 博客仓库',
        enabled: true,
        systemPrompt: '你是博客发布助手',
        workingDirectory: '/Users/dev/blog',
        allowedSkillIds: ['hugo-publish', 'disabled-skill'],
        modelSelection: {
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          reasoningEffort: 'high',
        },
        collaborationMode: SubagentCollaborationMode.Disabled,
        allowAgentIds: [],
        skillSummaries: [
          { id: 'hugo-publish', name: 'Hugo 博客发布', description: '推送博客仓库' },
        ],
      },
    ]);
  });

  test('canonicalizes legacy OpenClaw provider IDs on explicit specialist agent model selections', () => {
    const agents: Agent[] = [
      makeAgent({
        id: 'glm-specialist',
        name: 'GLM 专家',
        model: 'zai/glm-5.3',
        thinkingLevel: 'high',
      }),
      makeAgent({
        id: 'gemini-specialist',
        name: 'Gemini 专家',
        model: 'google/gemini-3.1-pro-preview',
      }),
      makeAgent({
        id: 'copilot-specialist',
        name: 'Copilot 专家',
        model: 'lobsterai-copilot/gpt-5-mini',
      }),
      makeAgent({
        id: 'minimax-specialist',
        name: 'MiniMax 专家',
        model: 'minimax-portal/MiniMax-M3',
      }),
      makeAgent({
        id: 'codex-specialist',
        name: 'Codex 专家',
        model: 'openai-codex/gpt-5.4',
      }),
    ];

    const specs = buildDshHostAgentSpecs({
      agents,
      resolveExplicitModel: (agent) => {
        const [provider, model] = agent.model.split('/');
        return provider && model
          ? { provider, model, ...(agent.thinkingLevel ? { reasoningEffort: agent.thinkingLevel } : {}) }
          : null;
      },
    });

    expect(specs.map((s) => ({ id: s.id, modelSelection: s.modelSelection }))).toEqual([
      { id: 'glm-specialist', modelSelection: { provider: 'zhipu', model: 'glm-5.3', reasoningEffort: 'high' } },
      { id: 'gemini-specialist', modelSelection: { provider: 'gemini', model: 'gemini-3.1-pro-preview' } },
      { id: 'copilot-specialist', modelSelection: { provider: 'github-copilot', model: 'gpt-5-mini' } },
      { id: 'minimax-specialist', modelSelection: { provider: 'minimax', model: 'MiniMax-M3' } },
      { id: 'codex-specialist', modelSelection: { provider: 'openai', model: 'gpt-5.4' } },
    ]);
  });

  test('derives routing description from systemPrompt, identity, or workingDirectory when description is blank', () => {
    const agents: Agent[] = [
      makeAgent({
        id: 'rules-only',
        name: '周报助手',
        description: '',
        systemPrompt: '## 角色定位\n- 定位：将零散工作资料整理成结论先行的结构化周报。',
      }),
      makeAgent({
        id: 'identity-only',
        name: '知识管家',
        description: '   ',
        identity: '专注维护和检索个人 Obsidian 知识库。',
      }),
      makeAgent({
        id: 'folder-only',
        name: '项目助手',
        description: '',
        workingDirectory: '/Users/dev/lobsterai/',
      }),
    ];

    const specs = buildDshHostAgentSpecs({ agents });
    expect(specs.map(s => ({ id: s.id, description: s.description }))).toEqual([
      { id: 'rules-only', description: '将零散工作资料整理成结论先行的结构化周报。' },
      { id: 'identity-only', description: '专注维护和检索个人 Obsidian 知识库。' },
      { id: 'folder-only', description: 'workspace: lobsterai' },
    ]);
  });
});

describe('resolveAllowedSkillIdsForTurn', () => {
  test('returns empty array when optionSkillIds is explicitly empty (Plan Mode suppression)', () => {
    expect(resolveAllowedSkillIdsForTurn({
      agentId: AgentId.Main,
      agentSkillIds: [],
      optionSkillIds: [],
    })).toEqual([]);

    expect(resolveAllowedSkillIdsForTurn({
      agentId: 'expert-a',
      agentSkillIds: ['custom-a'],
      optionSkillIds: [],
    })).toEqual([]);
  });

  test('enforces expert agent.skillIds allowlist and intersects composer optionSkillIds without bypass', () => {
    // Undefined optionSkillIds -> expert's full bound allowlist.
    expect(resolveAllowedSkillIdsForTurn({
      agentId: 'expert-a',
      agentSkillIds: ['custom-a', 'docx'],
      optionSkillIds: undefined,
    })).toEqual(['custom-a', 'docx']);

    // Composer selecting a subset -> intersected subset.
    expect(resolveAllowedSkillIdsForTurn({
      agentId: 'expert-a',
      agentSkillIds: ['custom-a', 'docx'],
      optionSkillIds: ['custom-a'],
    })).toEqual(['custom-a']);

    // Composer attempting to pass an unbound skill -> stripped by intersection.
    expect(resolveAllowedSkillIdsForTurn({
      agentId: 'expert-a',
      agentSkillIds: ['custom-a'],
      optionSkillIds: ['custom-a', 'other-skill'],
    })).toEqual(['custom-a']);

    expect(resolveAllowedSkillIdsForTurn({
      agentId: 'expert-b',
      agentSkillIds: ['other-skill'],
      optionSkillIds: ['custom-a'],
    })).toEqual([]);
  });

  test('returns null for unrestricted agents even when composer passes preferred-candidate hints', () => {
    expect(resolveAllowedSkillIdsForTurn({
      agentId: AgentId.Main,
      agentSkillIds: ['ignored-for-main'],
      optionSkillIds: undefined,
    })).toBeNull();

    expect(resolveAllowedSkillIdsForTurn({
      agentId: AgentId.Main,
      agentSkillIds: [],
      optionSkillIds: ['docx'],
    })).toBeNull();

    expect(resolveAllowedSkillIdsForTurn({
      agentId: 'unrestricted-expert',
      agentSkillIds: [],
      optionSkillIds: ['docx'],
    })).toBeNull();
  });

  test('resolves hostCapabilities for Xiaohongshu experts, prompt-referenced html-render, and skin-creator agents', () => {
    expect(resolveHostCapabilitiesForAgent(
      makeAgent({ id: 'xhs-1', name: '小红书编辑', presetId: 'xiaohongshu-editor' }),
    )).toEqual([DshProgressiveCapability.HtmlRender]);

    expect(resolveHostCapabilitiesForAgent(
      makeAgent({
        id: 'poster-expert',
        name: '海报专家',
        systemPrompt: 'Use lobsterai_render_html_to_image to export posters.',
      }),
    )).toEqual([DshProgressiveCapability.HtmlRender]);

    expect(resolveHostCapabilitiesForAgent(
      makeAgent({ id: 'skin-agent', name: '换肤助手', skillIds: ['skin-creator'] }),
    )).toEqual([DshProgressiveCapability.SkinManage]);

    expect(resolveHostCapabilitiesForAgent(
      makeAgent({ id: 'plain-agent', name: '普通助手' }),
    )).toEqual([]);

    const specs = buildDshHostAgentSpecs({
      agents: [
        makeAgent({ id: 'xhs-1', name: '小红书编辑', presetId: 'xiaohongshu-editor' }),
      ],
    });
    expect(specs[0]?.hostCapabilities).toEqual([DshProgressiveCapability.HtmlRender]);
  });
});
