import { describe, expect, test } from 'vitest';

import {
  normalizeProposedPlanMarkdown,
  parseProposedPlanBlock,
} from './proposedPlanParser';

describe('parseProposedPlanBlock', () => {
  test('extracts a proposed plan and removes it from visible text', () => {
    expect(parseProposedPlanBlock('Intro\n<proposed_plan>\n- Step\n</proposed_plan>\nOutro')).toEqual({
      visibleText: 'Intro\nOutro',
      planText: '- Step',
    });
  });

  test('leaves text unchanged when no plan block exists', () => {
    expect(parseProposedPlanBlock('Intro')).toEqual({
      visibleText: 'Intro',
      planText: null,
    });
  });

  test('parses an incomplete streaming plan block without showing the tag', () => {
    expect(parseProposedPlanBlock('Intro\n<proposed_plan>\n- Step')).toEqual({
      visibleText: 'Intro',
      planText: '- Step',
    });
  });

  test('hides a partial opening tag while it is streaming', () => {
    expect(parseProposedPlanBlock('Intro\n<proposed_')).toEqual({
      visibleText: 'Intro',
      planText: null,
    });
  });

  test('accepts case-insensitive tags with attributes', () => {
    expect(parseProposedPlanBlock('<PROPOSED_PLAN data-source="model">\n- Step\n</PROPOSED_PLAN>')).toEqual({
      visibleText: '',
      planText: '- Step',
    });
  });

  test('ignores inline tag mentions before the real plan block', () => {
    expect(parseProposedPlanBlock([
      'Plan Mode 要求我输出 <proposed_plan> 格式。',
      '下面才是真正的计划内容：',
      '<proposed_plan>',
      'Summary',
      '讲解一元二次方程。',
      '</proposed_plan>',
    ].join('\n'))).toEqual({
      visibleText: 'Plan Mode 要求我输出 <proposed_plan> 格式。\n下面才是真正的计划内容：',
      planText: 'Summary\n讲解一元二次方程。',
      ignoredInlineOpenTagCount: 1,
    });
  });

  test('normalizes inline section labels in proposed plans', () => {
    expect(parseProposedPlanBlock('<proposed_plan>\nSummary: Build the page.\n</proposed_plan>')).toEqual({
      visibleText: '',
      planText: '## Summary\n\nBuild the page.',
      didNormalizePlanText: true,
    });
  });

  test('normalizes section labels followed by Chinese connector text', () => {
    expect(parseProposedPlanBlock('<proposed_plan>\nSummary为「麦田烘焙」制作单页展示网页。\n</proposed_plan>')).toEqual({
      visibleText: '',
      planText: '## Summary\n\n为「麦田烘焙」制作单页展示网页。',
      didNormalizePlanText: true,
    });
  });

  test('normalizes heading-style section labels with bodies on the same line', () => {
    expect(parseProposedPlanBlock([
      '<proposed_plan>',
      '## Summary 创建生日派对邀请函网页。 ## Implementation Approach 1. 创建 index.html。',
      '</proposed_plan>',
    ].join('\n'))).toEqual({
      visibleText: '',
      planText: [
        '## Summary',
        '',
        '创建生日派对邀请函网页。',
        '## Implementation Approach',
        '',
        '1. 创建 index.html。',
      ].join('\n'),
      didNormalizePlanText: true,
    });
  });

  test('normalizes bold section labels with bodies on the same line', () => {
    expect(parseProposedPlanBlock([
      '<proposed_plan>',
      '**Summary** 制作季度汇报 PPT。 **Implementation Approach** 1. 使用 html2pptx 工作流。',
      '</proposed_plan>',
    ].join('\n'))).toEqual({
      visibleText: '',
      planText: [
        '## Summary',
        '',
        '制作季度汇报 PPT。',
        '## Implementation Approach',
        '',
        '1. 使用 html2pptx 工作流。',
      ].join('\n'),
      didNormalizePlanText: true,
    });
  });

  test('normalizes bold-only section labels before bodies on the next line', () => {
    expect(parseProposedPlanBlock([
      '<proposed_plan>',
      '**Summary**',
      '为「麦田烘焙」制作一个温馨文艺风格的单页展示网站。',
      '',
      '**Implementation Approach**',
      '1. 使用纯 HTML + CSS + JS 创建 index.html。',
      '</proposed_plan>',
    ].join('\n'))).toEqual({
      visibleText: '',
      planText: [
        '## Summary',
        '为「麦田烘焙」制作一个温馨文艺风格的单页展示网站。',
        '',
        '## Implementation Approach',
        '1. 使用纯 HTML + CSS + JS 创建 index.html。',
      ].join('\n'),
      didNormalizePlanText: true,
    });
  });
});

describe('normalizeProposedPlanMarkdown', () => {
  test('moves known section bodies to the line after the heading', () => {
    expect(normalizeProposedPlanMarkdown([
      '**Summary:** 生成科普内容。',
      '## Implementation Approach: Use structured sections.',
      '**Summary** 为客户创建单页网站。',
      'Key Changes: Add examples.',
    ].join('\n'))).toBe([
      '## Summary',
      '',
      '生成科普内容。',
      '## Implementation Approach',
      '',
      'Use structured sections.',
      '## Summary',
      '',
      '为客户创建单页网站。',
      '## Key Changes',
      '',
      'Add examples.',
    ].join('\n'));
  });

  test('does not normalize labels inside fenced code blocks', () => {
    expect(normalizeProposedPlanMarkdown([
      '```md',
      'Summary: Keep this literal.',
      '```',
      'Validation: Run tests.',
    ].join('\n'))).toBe([
      '```md',
      'Summary: Keep this literal.',
      '```',
      '## Validation',
      '',
      'Run tests.',
    ].join('\n'));
  });
});
