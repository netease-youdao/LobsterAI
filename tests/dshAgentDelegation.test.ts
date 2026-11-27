import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

const helpersUrl = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/agent-delegation-helpers.mjs'),
).href;
const sharedStateUrl = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/shared-state.mjs'),
).href;

describe('dsh agent-delegation helpers', () => {
  test('resolveCollaborators enforces all, allowlist, disabled, enabled state, and anti-cycle ancestry', async () => {
    const { resolveCollaborators } = await import(helpersUrl);
    const agents = new Map([
      ['main', { id: 'main', name: '主 Agent', enabled: true, collaborationMode: 'all', allowAgentIds: [] }],
      ['translator', { id: 'translator', name: '翻译专家', enabled: true, collaborationMode: 'all', allowAgentIds: [] }],
      ['blog-uuid', { id: 'blog-uuid', name: '博客自动发布', enabled: true, collaborationMode: 'allowlist', allowAgentIds: ['translator', 'disabled-agent'] }],
      ['isolated', { id: 'isolated', name: '隔离专家', enabled: true, collaborationMode: 'disabled', allowAgentIds: ['main'] }],
      ['disabled-agent', { id: 'disabled-agent', name: '已停用', enabled: false, collaborationMode: 'all', allowAgentIds: [] }],
    ]);
    const order = ['main', 'translator', 'blog-uuid', 'isolated', 'disabled-agent'];

    // Default `all` mode exposes every other enabled agent in order.
    expect(resolveCollaborators(agents, order, 'translator').map((a: { id: string }) => a.id)).toEqual([
      'main',
      'blog-uuid',
      'isolated',
    ]);

    // Depth-1 anti-cycle: main -> translator cannot delegate back to main or translator.
    expect(
      resolveCollaborators(agents, order, 'translator', new Set(['main', 'translator']))
        .map((a: { id: string }) => a.id),
    ).toEqual(['blog-uuid', 'isolated']);

    // `allowlist` mode includes only enabled whitelisted targets.
    expect(resolveCollaborators(agents, order, 'blog-uuid').map((a: { id: string }) => a.id)).toEqual([
      'translator',
    ]);

    // `disabled` mode exposes nothing even if allowAgentIds still retains prior selections.
    expect(resolveCollaborators(agents, order, 'isolated')).toEqual([]);
  });

  test('resolveTargetAgentInput matches exact id, unique display name, and rejects ambiguity or unauthorized targets', async () => {
    const { resolveTargetAgentInput } = await import(helpersUrl);
    const collaborators = [
      { id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', name: '博客自动发布' },
      { id: 'writer-1', name: '写作助手' },
      { id: 'writer-2', name: '写作助手' },
    ];

    expect(resolveTargetAgentInput(collaborators, '3fa85f64-5717-4562-b3fc-2c963f66afa6')).toEqual({
      ok: true,
      agent: collaborators[0],
    });
    expect(resolveTargetAgentInput(collaborators, '博客自动发布')).toEqual({
      ok: true,
      agent: collaborators[0],
    });
    expect(resolveTargetAgentInput(collaborators, '写作助手')).toMatchObject({
      ok: false,
      error: expect.stringContaining('Multiple collaborator agents share the name'),
    });
    expect(resolveTargetAgentInput(collaborators, 'unknown')).toMatchObject({
      ok: false,
      error: expect.stringContaining('not available for delegation'),
    });
  });

  test('deriveDelegationChildName validates explicit names, skips UUIDs, and deduplicates slugs', async () => {
    const { deriveDelegationChildName } = await import(helpersUrl);

    expect(deriveDelegationChildName({ id: 'x' }, new Set(), 'blog-publisher')).toEqual({
      ok: true,
      name: 'blog-publisher',
      explicit: true,
    });
    expect(deriveDelegationChildName({ id: 'x' }, new Set(), 'lead')).toMatchObject({ ok: false });
    expect(deriveDelegationChildName({ id: 'x' }, new Set(), 'Bad_Name')).toMatchObject({ ok: false });

    // Custom UUID agent with Chinese name falls back to undefined (DSH auto agent-N).
    expect(deriveDelegationChildName({
      id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      name: '博客自动发布',
    }, new Set())).toEqual({
      ok: true,
      name: undefined,
      explicit: false,
    });

    // Preset slug deduplicates cleanly against taken sibling names.
    expect(deriveDelegationChildName(
      { id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', presetId: 'blog-publisher', name: '博客自动发布' },
      new Set(['blog-publisher']),
    )).toEqual({
      ok: true,
      name: 'blog-publisher-2',
      explicit: false,
    });
  });

  test('formatCollaboratorRosterPrompt renders skills and caps inline rows cleanly', async () => {
    const { formatCollaboratorRosterPrompt } = await import(helpersUrl);
    const collaborators = [
      {
        id: 'blog-uuid',
        name: '博客自动发布',
        description: '自动把文章发布到个人 Hugo 博客',
        skillSummaries: [{ id: 'hugo-publish', name: 'Hugo 发布' }],
      },
      {
        id: 'video-uuid',
        name: '视频转文章',
        description: '把视频整理成图文',
        skillSummaries: [],
      },
    ];

    const full = formatCollaboratorRosterPrompt(collaborators, { maxInline: 10 });
    expect(full).toContain('`blog-uuid` (博客自动发布)');
    expect(full).toContain('[skills: Hugo 发布]');
    expect(full).toContain('`delegate_agent`');
    expect(full).not.toContain('list_collaborator_agents');

    const capped = formatCollaboratorRosterPrompt(collaborators, { maxInline: 1 });
    expect(capped).toContain('`blog-uuid`');
    expect(capped).not.toContain('`video-uuid`');
    expect(capped).toContain('list_collaborator_agents');
  });

  test('resolveCollaboratorDescription falls back to systemPrompt and workingDirectory when description is blank', async () => {
    const { formatCollaboratorRosterPrompt, resolveCollaboratorDescription } = await import(helpersUrl);

    expect(resolveCollaboratorDescription({
      id: 'weekly',
      name: '周报助手',
      description: '',
      systemPrompt: '## 角色与规则\n- 定位：把工作记录整理为结论先行的结构化周报。',
    })).toBe('把工作记录整理为结论先行的结构化周报。');

    expect(resolveCollaboratorDescription({
      id: 'repo-agent',
      name: '项目专家',
      description: '',
      workingDirectory: '/Users/dev/my-app/',
    })).toBe('workspace: my-app');

    const prompt = formatCollaboratorRosterPrompt([
      {
        id: 'weekly',
        name: '周报助手',
        description: '',
        systemPrompt: '把工作记录整理为结论先行的结构化周报。',
        skillSummaries: [],
      },
    ]);
    expect(prompt).toContain('`weekly` (周报助手): 把工作记录整理为结论先行的结构化周报。');
  });
});

describe('resolveSessionContext delegated specialist & cold resume support', () => {
  test('resolves depth-1 and cold-resumed depth-2 delegated specialists with live parent traceId', async () => {
    const { resolveSessionContext } = await import(sharedStateUrl);
    const liveHeaders = new Map([
      // Depth-1 agent is offline (cold resume of depth-2 grandchild!)
      ['child-2', { origin: 'subagent', parentSession: 'child-1' }],
    ]);
    const ctx = {
      get: () => ({
        get: (id: string) => (liveHeaders.has(id) ? { session: { header: liveHeaders.get(id) } } : undefined),
      }),
    };
    const state = {
      sessionContexts: new Map([
        ['root-dsh', {
          agentId: 'main',
          coworkSessionId: 'cw-root',
          traceId: 'trace-turn-5',
          workspaceDir: '/root/cwd',
          executionMode: 'auto',
          permissionPreset: 'workspace-write',
        }],
      ]),
      agents: new Map([
        ['translator', {
          id: 'translator',
          name: '翻译专家',
          allowedSkillIds: ['baoyu-post-to-wechat'],
          systemPrompt: 'Translator soul',
        }],
        ['blog-publisher', {
          id: 'blog-publisher',
          name: '博客自动发布',
          allowedSkillIds: ['hugo-publish'],
          systemPrompt: 'Blog publisher soul',
          workingDirectory: '/Users/dev/blog',
        }],
      ]),
      delegatedChildAgents: new Map([
        ['child-1', {
          targetAgentId: 'translator',
          parentDshSessionId: 'root-dsh',
          rootCoworkSessionId: 'cw-root',
        }],
        ['child-2', {
          targetAgentId: 'blog-publisher',
          parentDshSessionId: 'child-1',
          rootCoworkSessionId: 'cw-root',
        }],
      ]),
    };

    expect(resolveSessionContext(ctx, state, 'child-2')).toEqual({
      agentId: 'blog-publisher',
      coworkSessionId: 'cw-root',
      traceId: 'trace-turn-5',
      workspaceDir: '/Users/dev/blog',
      allowedSkillIds: ['hugo-publish'],
      customSystemPrompt: 'Blog publisher soul',
      executionMode: 'auto',
      permissionPreset: 'workspace-write',
    });

    // Deleted target agent falls back gracefully without crashing.
    state.agents.delete('blog-publisher');
    expect(resolveSessionContext(ctx, state, 'child-2')).toEqual({
      agentId: 'blog-publisher',
      coworkSessionId: 'cw-root',
      traceId: 'trace-turn-5',
      workspaceDir: '/root/cwd',
      allowedSkillIds: null,
      executionMode: 'auto',
      permissionPreset: 'workspace-write',
    });
  });
});
