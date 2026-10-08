import { describe, expect, test } from 'vitest';

import { classifyWaitingNotificationKind, WaitingNotificationKind } from '../notifications/constants';
import {
  OpenClawQuestion,
  type OpenClawQuestionItem,
  OpenClawQuestionStatus,
  parseOpenClawQuestionAnswers,
  parseOpenClawQuestionRecord,
} from './openclawQuestion';

const question: OpenClawQuestionItem = {
  questionId: 'choice', header: '选择', question: '选哪个？',
  options: [{ label: 'A (Recommended)' }, { label: 'B|||C' }], isOther: true,
};
const record = {
  id: 'request', questions: [question], sessionKey: 'agent:main:lobsterai:session',
  expiresAtMs: 100_000, status: OpenClawQuestionStatus.Pending,
};

describe('native question contract', () => {
  test('preserves stable question IDs and exact model-provided labels', () => {
    expect(parseOpenClawQuestionRecord(record)?.questions).toEqual([{ ...question, multiSelect: false }]);
    expect(parseOpenClawQuestionAnswers([question], { choice: ['A (Recommended)'] }))
      .toEqual({ choice: ['A (Recommended)'] });
  });

  test('keeps identical question text and separator-containing multi-select labels distinct', () => {
    const questions = [question, { ...question, questionId: 'second', multiSelect: true }];
    const answers = { choice: ['free-form answer'], second: ['A (Recommended)', 'B|||C'] };
    expect(parseOpenClawQuestionAnswers(questions, answers)).toEqual(answers);
  });

  test.each([
    {}, { choice: 'A' }, { choice: [] }, { choice: ['  '] },
    { choice: ['A', 'B'] }, { choice: ['A'], unknown: ['B'] },
  ])('rejects incomplete or malformed answers %j', (answers) => {
    expect(parseOpenClawQuestionAnswers([question], answers)).toBeNull();
  });

  test('allows text for free-text questions but rejects unlisted closed choices', () => {
    expect(parseOpenClawQuestionAnswers([{ ...question, options: [] }], { choice: ['text'] }))
      .toEqual({ choice: ['text'] });
    expect(parseOpenClawQuestionAnswers([{ ...question, isOther: false }], { choice: ['unlisted'] })).toBeNull();
  });

  test.each([
    { questions: [question, question] },
    { questions: [{ ...question, isSecret: true }] },
    { questions: [{ ...question, secretStore: { name: 'API_KEY' } }] },
    { questions: [{ ...question, questionId: undefined }] },
    { sessionKey: '' }, { expiresAtMs: Infinity }, { status: 'invalid' },
  ])('rejects malformed or unsupported records %j', (override) => {
    expect(parseOpenClawQuestionRecord({ ...record, ...override })).toBeNull();
  });

  test('native questions use the question notification preference', () => {
    expect(classifyWaitingNotificationKind(OpenClawQuestion.ToolName)).toBe(WaitingNotificationKind.Question);
  });
});
