import { expect, test } from 'vitest';

import { parseProgressCard, ProgressCardStepStatus } from './progressCard';

const SESSION_KEY = 'agent:main:lobsterai:118d4ab5-131a-4e26-98a7-bd10e1781388';
const card = {
  sessionKey: SESSION_KEY,
  revision: 2,
  updatedAt: 1_790_000_000_000,
  markdown: '**Anthropic 公司介绍 PPT**',
  steps: [
    { step: '调研 Anthropic 关键事实', status: ProgressCardStepStatus.Completed },
    { step: '确定设计语言与内容大纲', status: ProgressCardStepStatus.InProgress },
  ],
};

test('a session without a card reads as null', () => {
  expect(parseProgressCard({ card: null }, SESSION_KEY)).toBeNull();
});

test('a valid card comes back as given, markdown-only and steps-only included', () => {
  expect(parseProgressCard({ card }, SESSION_KEY)).toEqual(card);
  const { steps: _steps, ...noteOnly } = card;
  expect(parseProgressCard({ card: noteOnly }, SESSION_KEY)).toEqual(noteOnly);
  const { markdown: _markdown, ...stepsOnly } = card;
  expect(parseProgressCard({ card: stepsOnly }, SESSION_KEY)).toEqual(stepsOnly);
});

test('the gateway may return the canonical, lowercased key of the session asked for', () => {
  const mixedCase = 'agent:main:weixin:o9cq807Dqrw';
  const stored = { ...card, sessionKey: mixedCase.toLowerCase() };
  expect(parseProgressCard({ card: stored }, mixedCase)?.sessionKey).toBe(mixedCase.toLowerCase());
});

test('malformed cards and cards of another session are rejected', () => {
  expect(() => parseProgressCard(undefined, SESSION_KEY)).toThrow();
  expect(() => parseProgressCard({}, SESSION_KEY)).toThrow();
  expect(() => parseProgressCard({ card: { ...card, sessionKey: 'agent:main:lobsterai:other' } }, SESSION_KEY)).toThrow();
  expect(() => parseProgressCard({ card: { ...card, revision: 0 } }, SESSION_KEY)).toThrow();
  expect(() => parseProgressCard({ card: { ...card, steps: [{ step: 'x', status: 'made-up' }] } }, SESSION_KEY)).toThrow();
  expect(() => parseProgressCard({ card: { ...card, steps: [{ step: ' ', status: 'pending' }] } }, SESSION_KEY)).toThrow();
  expect(() => parseProgressCard({ card: { ...card, markdown: '  ', steps: [] } }, SESSION_KEY)).toThrow();
});
