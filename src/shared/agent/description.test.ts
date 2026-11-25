import { describe, expect, test } from 'vitest';

import {
  deriveAgentRoutingDescription,
  normalizeAgentSummaryDescription,
} from './description';

describe('deriveAgentRoutingDescription', () => {
  test('prefers explicit description and normalizes whitespace', () => {
    expect(deriveAgentRoutingDescription({
      description: '  负责整理\n每周团队周报  ',
      systemPrompt: '你是代码审查专家',
      workingDirectory: '/Users/dev/project',
    })).toBe('负责整理 每周团队周报');
  });

  test('falls back to cleaned excerpt from systemPrompt when description is blank', () => {
    const prompt = [
      '---',
      'name: reviewer',
      '---',
      '## 角色定位',
      '```ts',
      'const ignored = true;',
      '```',
      '- 定位：专注 **TypeScript** 架构评审与 [性能分析](https://example.com)',
      '- 输出风格：逐条列出风险',
    ].join('\n');

    expect(deriveAgentRoutingDescription({
      description: '   ',
      systemPrompt: prompt,
    })).toBe('专注 TypeScript 架构评审与 性能分析');
  });

  test('joins short first line with second meaningful line and clamps cleanly at sentence boundary', () => {
    expect(deriveAgentRoutingDescription({
      description: '',
      systemPrompt: '周报整理助手\n把零散的会议记录整理成结论先行的结构化周报。',
    })).toBe('周报整理助手；把零散的会议记录整理成结论先行的结构化周报。');

    const longSentence = 'Focus on auditing TypeScript pull requests for subtle concurrency bugs and memory leaks. Always provide concrete minimal patches with full test coverage and benchmark details for every single finding.';
    const derived = deriveAgentRoutingDescription({ description: '', systemPrompt: longSentence }, 100);
    expect(derived).toBe('Focus on auditing TypeScript pull requests for subtle concurrency bugs and memory leaks.');
    expect(derived.length).toBeLessThanOrEqual(100);
  });

  test('falls back to identity, then workingDirectory basename, then empty string', () => {
    expect(deriveAgentRoutingDescription({
      description: '',
      systemPrompt: '',
      identity: '个人知识库管家，擅长检索和整理 Obsidian 笔记。',
      workingDirectory: '/Users/dev/notes',
    })).toBe('个人知识库管家，擅长检索和整理 Obsidian 笔记。');

    expect(deriveAgentRoutingDescription({
      description: '',
      systemPrompt: '',
      identity: '',
      workingDirectory: '/Users/dev/lobsterai/',
    })).toBe('workspace: lobsterai');

    expect(deriveAgentRoutingDescription({
      description: '',
      systemPrompt: '',
      identity: '',
      workingDirectory: 'C:\\Work\\weekly-reports\\',
    })).toBe('workspace: weekly-reports');

    expect(deriveAgentRoutingDescription({
      description: '',
      systemPrompt: '',
      identity: '',
      workingDirectory: '',
    })).toBe('');
  });
});

describe('normalizeAgentSummaryDescription', () => {
  test('unwraps code fences, prefixes, bullets, and outer quotes into one clean line', () => {
    expect(normalizeAgentSummaryDescription('```\n简介：「将会议纪要整理为结构化周报」\n多余说明\n```'))
      .toBe('将会议纪要整理为结构化周报');
    expect(normalizeAgentSummaryDescription('- Summary: "Audits TypeScript PRs for regressions"'))
      .toBe('Audits TypeScript PRs for regressions');
    expect(normalizeAgentSummaryDescription('   ')).toBe('');
  });
});
