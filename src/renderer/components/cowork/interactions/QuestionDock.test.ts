import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import type { CoworkPermissionRequest } from '../../../types/cowork';
import QuestionDock, { QuestionDockCard } from './QuestionDock';
import { permissionDockRequest } from './questionDockModel';

vi.mock('../../../services/cowork', () => ({ coworkService: { respondToPermission: vi.fn() } }));
vi.mock('../../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('./questionDock.css', () => ({}));

const options = [{ label: 'A (Recommended)' }, { label: 'B', description: 'second' }];

const plugin: CoworkPermissionRequest = {
  sessionId: 's', requestId: 'r', toolName: 'AskUserQuestion',
  toolInput: { questions: [{ question: 'Which?', options }, { question: 'When?', options }] },
};

const native = (question: Record<string, unknown>): CoworkPermissionRequest => ({
  sessionId: 's', requestId: 'openclaw-question:q', toolName: 'ask_user',
  toolInput: { id: 'q', sessionKey: 'k', expiresAtMs: Date.now() + 60_000, status: 'pending', questions: [question] },
});

const renderCard = (permission: CoworkPermissionRequest, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(QuestionDockCard, { request: permissionDockRequest(permission)!, ...props }));

describe('QuestionDockCard', () => {
  test('renders one plugin question at a time with numbered options, free text and skip', () => {
    const html = renderCard(plugin, { queueCount: 2 });
    expect(html).toContain('<h2>Which?</h2>');
    expect(html).not.toContain('When?');
    expect(html).toContain('1 / 2');
    expect(html.match(/class="cowork-question-option/g)).toHaveLength(2);
    expect(html).toContain('<strong>A coworkQuestionDockRecommended</strong>');
    expect(html).toContain('is-highlighted');
    expect(html).toContain('<textarea');
    expect(html).toContain('cowork-question-skip');
    expect(html).toContain('coworkQuestionDockQueue');
  });

  test('native questions cannot be skipped and only accept typed answers when allowed', () => {
    const plain = renderCard(native({ questionId: 'style', header: 'Style', question: 'Which style?', options }));
    expect(plain).not.toContain('cowork-question-skip');
    expect(plain).not.toContain('<textarea');
    expect(plain).not.toContain('<footer');
    const other = renderCard(native({ questionId: 'style', header: 'Style', question: 'Which style?', options, isOther: true }));
    expect(other).toContain('<textarea');
    expect(other).not.toContain('cowork-question-skip');
  });

  test('is not rendered while hidden', () => {
    expect(renderCard(plugin, { hidden: true })).toBe('');
  });
});

describe('QuestionDock', () => {
  test('shows only requests from the open session and skips ones the dock cannot render', () => {
    const other = { ...plugin, requestId: 'other', sessionId: 'other' };
    const approval: CoworkPermissionRequest = { sessionId: 's', requestId: 'p', toolName: 'Bash', toolInput: { command: 'ls' } };
    expect(renderToStaticMarkup(createElement(QuestionDock, { sessionId: 's', permissions: [approval, other] }))).toBe('');
    const html = renderToStaticMarkup(createElement(QuestionDock, { sessionId: 's', permissions: [approval, other, plugin] }));
    expect(html).toContain('<h2>Which?</h2>');
    expect(html).not.toContain('coworkQuestionDockQueue');
  });
});
