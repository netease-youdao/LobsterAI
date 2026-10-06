import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { ASK_USER_QUESTION_TOOL_NAME } from '../../../shared/cowork/constants';
import { OpenClawQuestion, OpenClawQuestionStatus } from '../../../shared/cowork/openclawQuestion';
import CoworkNativeQuestionModal from './CoworkNativeQuestionModal';
import CoworkPermissionModal from './CoworkPermissionModal';
import { stripQuestionRecommendation } from './questionOptionLabel';

vi.mock('../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

describe('question option presentation', () => {
  test.each(['允许删除 (Recommended)', '允许删除（推荐）', '允许删除 (recommended)  '])(
    'removes a terminal recommendation from %s', (label) => {
      expect(stripQuestionRecommendation(label)).toBe('允许删除');
    },
  );

  test('preserves ordinary prose, empty-label edge cases and non-terminal parentheses', () => {
    expect(stripQuestionRecommendation('Read recommended docs')).toBe('Read recommended docs');
    expect(stripQuestionRecommendation('(Recommended)')).toBe('(Recommended)');
    expect(stripQuestionRecommendation('A (Recommended) details')).toBe('A (Recommended) details');
  });

  test('the legacy delete confirmation hides the suffix without mutating its tool input', () => {
    const permission = {
      requestId: 'legacy', sessionId: 'session', toolName: ASK_USER_QUESTION_TOOL_NAME,
      toolInput: { questions: [{
        question: '允许删除文件吗？', options: [{ label: '允许删除 (Recommended)' }, { label: '取消' }],
      }] },
    };
    const markup = renderToStaticMarkup(createElement(CoworkPermissionModal, { permission, onRespond: () => {} }));
    expect(markup).toContain('允许删除</button>');
    expect(markup).not.toContain('Recommended');
    expect(permission.toolInput.questions[0].options[0].label).toBe('允许删除 (Recommended)');
  });

  test('native two-choice questions retain other input and have no preselected or auto-submitted recommendation', () => {
    const permission = {
      requestId: 'native', sessionId: 'session', toolName: OpenClawQuestion.ToolName,
      toolInput: {
        id: 'native', sessionKey: 'agent:main:lobsterai:session', status: OpenClawQuestionStatus.Pending,
        expiresAtMs: Date.now() + 10_000,
        questions: [{ questionId: 'topic', header: 'Topic', question: 'Choose a topic', isOther: true,
          options: [{ label: 'A (Recommended)' }, { label: 'B' }] }],
      },
    };
    const markup = renderToStaticMarkup(createElement(CoworkNativeQuestionModal, { permission, onRespond: () => {} }));
    expect(markup).toContain('<textarea');
    expect(markup).toContain('name="topic"');
    expect(markup).not.toContain('checked=""');
    expect(markup).toContain('type="submit" disabled=""');
    // The submitted value is original, while the visible label is neutral.
    expect(markup).toContain('value="A (Recommended)"');
    expect(markup).not.toContain('>A (Recommended)<');
  });
});
