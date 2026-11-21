import { describe, expect, test } from 'vitest';

import {
  AgentId,
  AgentModelSelectionMode,
  AgentSource,
  SubagentCollaborationMode,
} from '../../../shared/agent/constants';
import type { Agent } from '../../coworkStore';
import { buildDshHostAgentSpecs } from './dshAgentSync';

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
});
