import { describe, expect, test } from 'vitest';

import {
  buildCompanionQuickAnswerPrompt,
  COMPANION_SELECTION_MAX_CHARS,
  CompanionSelectionAction,
  companionTranslationTarget,
  isMostlyChinese,
  rankCompanionSelectionActions,
} from './selectionActions';

const A = CompanionSelectionAction;

describe('selection action ranking', () => {
  test('offers translation first for foreign text', () => {
    expect(rankCompanionSelectionActions('ambient co-worker')[0]).toBe(A.Translate);
    expect(rankCompanionSelectionActions('A long English paragraph about agents. '.repeat(8))[0]).toBe(A.Translate);
  });

  test('offers an explanation first for a short Chinese term', () => {
    const actions = rankCompanionSelectionActions('边际效应');
    expect(actions[0]).toBe(A.Explain);
    expect(actions).not.toContain(A.Summarize);
  });

  test('offers a summary first for a long Chinese passage', () => {
    expect(rankCompanionSelectionActions('这是一段很长的中文材料。'.repeat(30))[0]).toBe(A.Summarize);
  });

  test('always keeps ask as the last resort', () => {
    for (const text of ['hi', '你好世界', 'x'.repeat(500)]) {
      const actions = rankCompanionSelectionActions(text);
      expect(actions[actions.length - 1]).toBe(A.Ask);
    }
  });
});

describe('translation direction', () => {
  test('Chinese goes to English and everything else to Chinese', () => {
    expect(isMostlyChinese('LobsterAI 是一个桌面助手')).toBe(true);
    expect(companionTranslationTarget('桌面助手')).toBe('en');
    expect(companionTranslationTarget('desktop helper')).toBe('zh');
    expect(companionTranslationTarget('デスクトップ')).toBe('zh');
  });
});

describe('quick answer prompt', () => {
  test('wraps the selection and names the translation target', () => {
    const prompt = buildCompanionQuickAnswerPrompt({ action: A.Translate, text: '  hello world  ', language: 'zh' });
    expect(prompt.system).toContain('简体中文');
    expect(prompt.messages).toEqual([{ role: 'user', content: '<selected_text>\nhello world\n</selected_text>' }]);
  });

  test('puts the first question of an ask next to the selection', () => {
    const prompt = buildCompanionQuickAnswerPrompt({ action: A.Ask, text: 'GDP grew 5%', question: 'Is that high?', language: 'en' });
    expect(prompt.messages[0].content).toContain('Question: Is that high?');
  });

  test('switches to a follow-up instruction so a translate prompt does not translate questions', () => {
    const prompt = buildCompanionQuickAnswerPrompt({
      action: A.Translate,
      text: 'hello',
      language: 'zh',
      history: [{ role: 'assistant', content: '你好' }, { role: 'user', content: '还有别的译法吗？' }],
    });
    expect(prompt.system).not.toContain('只输出译文');
    expect(prompt.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  test('keeps roles alternating and caps very long selections', () => {
    const prompt = buildCompanionQuickAnswerPrompt({
      action: A.Explain,
      text: '字'.repeat(COMPANION_SELECTION_MAX_CHARS + 50),
      language: 'zh',
      history: [{ role: 'assistant', content: '解释' }],
    });
    expect(prompt.messages[prompt.messages.length - 1].role).toBe('user');
    expect([...prompt.messages[0].content].length).toBeLessThan(COMPANION_SELECTION_MAX_CHARS + 40);
  });
});
