import { describe, expect, test } from 'vitest';

import {
  getSubagentDisplayInitial,
  getSubagentDisplayName,
  getSubagentTargetAgentName,
} from './subagentDisplay';

const agents = [
  { id: 'main', name: 'LobsterAI' },
  { id: 'translator', name: '翻译专家' },
  { id: 'blog-publisher', name: '博客自动发布' },
];

describe('subagentDisplay helpers', () => {
  test('surfaces target specialist agent name and initial only for cross-agent delegations', () => {
    const delegated = { label: '发布文章到个人博客', agentId: 'blog-publisher' };
    expect(getSubagentDisplayName(delegated, agents)).toBe('发布文章到个人博客');
    expect(getSubagentTargetAgentName(delegated, agents, 'translator')).toBe('博客自动发布');
    expect(getSubagentDisplayInitial(delegated, agents, 'translator')).toBe('博');

    // Same-agent self subagent returns null target badge and uses label initial.
    const selfRun = { label: '并行检查段落', agentId: 'translator' };
    expect(getSubagentTargetAgentName(selfRun, agents, 'translator')).toBeNull();
    expect(getSubagentDisplayInitial(selfRun, agents, 'translator')).toBe('并');
  });
});
