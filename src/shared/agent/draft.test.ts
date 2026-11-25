import { describe, expect, test } from 'vitest';

import { AgentAvatarSvg } from './avatar';
import {
  AgentDraftLanguage,
  AgentDraftMode,
  AgentRulePolishDirective,
  buildAgentDraftPrompt,
  detectPreferredAgentLanguage,
  extractStreamingDraftPreview,
  extractStreamingPolishInstructions,
  extractStreamingPolishPreview,
  normalizePolishedInstructions,
  parseAgentDraftResponse,
  parsePolishedDraftOutput,
} from './draft';

describe('buildAgentDraftPrompt', () => {
  test('builds Chinese create prompt including goal, folder context, and skills', () => {
    const payload = buildAgentDraftPrompt(
      {
        mode: AgentDraftMode.Create,
        name: '视频转文章',
        goal: '把 B 站视频整理成公众号深度长文',
        workingDirectory: '/Users/demo/articles',
        skills: [
          { id: 'web-search', name: 'Web Search', description: 'Search the web' },
        ],
        language: AgentDraftLanguage.Zh,
      },
      'README.md: Personal newsletter drafts',
    );

    expect(payload.system).toContain('LobsterAI');
    expect(payload.system).toContain(AgentAvatarSvg.Creation);
    expect(payload.user).toContain('视频转文章');
    expect(payload.user).toContain('把 B 站视频整理成公众号深度长文');
    expect(payload.user).toContain('/Users/demo/articles');
    expect(payload.user).toContain('README.md: Personal newsletter drafts');
    expect(payload.user).toContain('web-search');
  });

  test('builds English polish prompt with existing instructions and omits skills catalog', () => {
    const payload = buildAgentDraftPrompt({
      mode: AgentDraftMode.Polish,
      name: 'Docs Editor',
      goal: 'Make instructions stricter about concise tone',
      existingInstructions: 'Help edit markdown docs.',
      skills: [{ id: 'web-search', name: 'Web Search', description: 'Search the web' }],
      language: AgentDraftLanguage.En,
    });

    expect(payload.system).toContain('Mode: Polish');
    expect(payload.system).toContain('Do NOT output JSON');
    expect(payload.user).toContain('Existing instructions:\nHelp edit markdown docs.');
    expect(payload.user).not.toContain('web-search');
  });

  test('injects targeted Chinese and English polish directives into polish prompts', () => {
    const zhConcise = buildAgentDraftPrompt({
      mode: AgentDraftMode.Polish,
      name: '个人助理',
      goal: '个人助理',
      existingInstructions: '回复专业，语气比较强势',
      polishDirective: AgentRulePolishDirective.Concise,
      language: AgentDraftLanguage.Zh,
    });
    expect(zhConcise.system).toContain('更简洁直接');
    expect(zhConcise.user).toContain('更简洁直接');

    const zhConclusion = buildAgentDraftPrompt({
      mode: AgentDraftMode.Polish,
      name: '分析助手',
      goal: '分析助手',
      existingInstructions: '帮我分析财报',
      polishDirective: AgentRulePolishDirective.ConclusionFirst,
      language: AgentDraftLanguage.Zh,
    });
    expect(zhConclusion.system).toContain('先给结论再展开');

    const enRigorous = buildAgentDraftPrompt({
      mode: AgentDraftMode.Polish,
      name: 'Code Helper',
      goal: 'Code Helper',
      existingInstructions: 'Help review pull requests.',
      polishDirective: AgentRulePolishDirective.Rigorous,
      language: AgentDraftLanguage.En,
    });
    expect(enRigorous.system).toContain('More rigorous & verified');
    expect(enRigorous.user).toContain('More rigorous & verified');

    const enFriendly = buildAgentDraftPrompt({
      mode: AgentDraftMode.Polish,
      name: 'Study Coach',
      goal: 'Study Coach',
      existingInstructions: 'Explain concepts.',
      polishDirective: AgentRulePolishDirective.Friendly,
      language: AgentDraftLanguage.En,
    });
    expect(enFriendly.system).toContain('Warmer & conversational');
  });

  test('builds polish prompt requesting SUMMARY header when includeDescription is true', () => {
    const zh = buildAgentDraftPrompt({
      mode: AgentDraftMode.Polish,
      name: '周报助手',
      goal: '周报助手',
      existingInstructions: '整理资料为周报',
      includeDescription: true,
      language: AgentDraftLanguage.Zh,
    });
    expect(zh.system).toContain('SUMMARY: ');

    const en = buildAgentDraftPrompt({
      mode: AgentDraftMode.Polish,
      name: 'Report Helper',
      goal: 'Report Helper',
      existingInstructions: 'Summarize weekly updates.',
      includeDescription: true,
      language: AgentDraftLanguage.En,
    });
    expect(en.system).toContain('Line 1 MUST start with `SUMMARY: `');
  });

  test('builds summary prompt from instructions and folder context', () => {
    const payload = buildAgentDraftPrompt(
      {
        mode: AgentDraftMode.Summary,
        name: '周报助手',
        goal: '周报助手',
        existingInstructions: '你负责把资料整理成结构化周报，先给结论再列细节。',
        workingDirectory: '/Users/demo/reports',
        language: AgentDraftLanguage.Zh,
      },
      'Top-level files: Q1.md, Q2.md',
    );
    expect(payload.system).toContain('简介提炼助手');
    expect(payload.user).toContain('角色与规则：\n你负责把资料整理成结构化周报，先给结论再列细节。');
    expect(payload.user).toContain('Top-level files: Q1.md, Q2.md');
  });
});

describe('detectPreferredAgentLanguage', () => {
  test('prefers Chinese for CJK text, English for Latin text, and falls back otherwise', () => {
    expect(detectPreferredAgentLanguage('整理周报助手', AgentDraftLanguage.En)).toBe(AgentDraftLanguage.Zh);
    expect(detectPreferredAgentLanguage('Code review specialist', AgentDraftLanguage.Zh)).toBe(AgentDraftLanguage.En);
    expect(detectPreferredAgentLanguage('12345', AgentDraftLanguage.En)).toBe(AgentDraftLanguage.En);
    expect(detectPreferredAgentLanguage('   ', AgentDraftLanguage.Zh)).toBe(AgentDraftLanguage.Zh);
  });
});

describe('streaming draft extractors', () => {
  test('strips accidental markdown code fences while streaming polished instructions', () => {
    expect(extractStreamingPolishInstructions('```markdown')).toBe('');
    expect(extractStreamingPolishInstructions('```markdown\n- 第一条\n- 第二条')).toBe('- 第一条\n- 第二条');
    expect(normalizePolishedInstructions('```md\n- 第一条\n- 第二条\n```')).toBe('- 第一条\n- 第二条');
  });

  test('incrementally extracts description and instructions from partial JSON stream', () => {
    const partial = '{"name":"助手","description":"帮你整理周报","instructions":"- 第一步\\n- 第二步\\"重点\\"\\u4e2d\\';
    expect(extractStreamingDraftPreview(partial)).toEqual({
      description: '帮你整理周报',
      instructions: '- 第一步\n- 第二步"重点"中',
    });
  });

  test('streams polish SUMMARY header cleanly without flashing raw tag into instructions', () => {
    expect(extractStreamingPolishPreview('SUM', true)).toEqual({});
    expect(extractStreamingPolishPreview('SUMMARY: 整理结构化周报', true)).toEqual({
      description: '整理结构化周报',
    });
    expect(extractStreamingPolishPreview('SUMMARY: 整理结构化周报\n\n- 先给结论\n- 再列细节', true)).toEqual({
      description: '整理结构化周报',
      instructions: '- 先给结论\n- 再列细节',
    });
    // Falls back immediately to instructions when the model omits SUMMARY.
    expect(extractStreamingPolishPreview('- 先给结论', true)).toEqual({
      instructions: '- 先给结论',
    });
  });

  test('parses final polished output with optional SUMMARY header and preserves fallback body', () => {
    expect(parsePolishedDraftOutput('SUMMARY: 「负责整理团队周报」\n\n- 先给结论\n- 再列细节', true)).toEqual({
      description: '负责整理团队周报',
      instructions: '- 先给结论\n- 再列细节',
    });
    expect(parsePolishedDraftOutput('简介：代码架构审查专家\n- 检查边界条件', true)).toEqual({
      description: '代码架构审查专家',
      instructions: '- 检查边界条件',
    });
    expect(parsePolishedDraftOutput('- 纯正文规则', true)).toEqual({
      description: '',
      instructions: '- 纯正文规则',
    });
    expect(parsePolishedDraftOutput('SUMMARY: 只有一行', true)).toEqual({
      description: '',
      instructions: 'SUMMARY: 只有一行',
    });
  });
});

describe('parseAgentDraftResponse', () => {
  test('parses fenced JSON, validates avatar, and filters unknown skills', () => {
    const raw = [
      'Here is the configuration:',
      '```json',
      JSON.stringify({
        name: '周报助手',
        description: '每周自动汇总工作进展并输出结构化周报',
        instructions: '- 汇总本周关键产出\n- 标注阻塞与下周计划',
        avatarSvg: 'document',
        recommendedSkillIds: ['docx', 'unknown-skill', 'docx'],
        starterPrompts: ['帮我整理本周会议纪要成周报', '帮我整理本周会议纪要成周报', '列出下周优先事项'],
      }),
      '```',
    ].join('\n');

    const result = parseAgentDraftResponse(raw, {
      allowedSkillIds: ['docx', 'xlsx'],
    });

    expect(result).toEqual({
      name: '周报助手',
      description: '每周自动汇总工作进展并输出结构化周报',
      instructions: '- 汇总本周关键产出\n- 标注阻塞与下周计划',
      avatarSvg: AgentAvatarSvg.Document,
      recommendedSkillIds: ['docx'],
      starterPrompts: ['帮我整理本周会议纪要成周报', '列出下周优先事项'],
    });
  });

  test('falls back to provided name and drops invalid avatar', () => {
    const raw = JSON.stringify({
      name: '',
      description: 'Codebase helper',
      instructions: 'Focus on minimal clean diffs.',
      avatarSvg: 'not-a-valid-avatar',
      recommendedSkillIds: [],
      starterPrompts: ['Review my latest diff'],
    });

    const result = parseAgentDraftResponse(raw, { fallbackName: 'lobsterai' });
    expect(result).toEqual({
      name: 'lobsterai',
      description: 'Codebase helper',
      instructions: 'Focus on minimal clean diffs.',
      recommendedSkillIds: [],
      starterPrompts: ['Review my latest diff'],
    });
  });

  test('returns null when JSON is malformed or instructions are empty', () => {
    expect(parseAgentDraftResponse('not json at all')).toBeNull();
    expect(parseAgentDraftResponse(JSON.stringify({ name: 'Empty', instructions: '   ' }))).toBeNull();
  });
});
