import { describe, expect, test } from 'vitest';

import type { CoworkPermissionRequest } from '../../../types/cowork';
import {
  emptyQuestionDraft,
  isQuestionDockRequest,
  permissionDockAnswer,
  permissionDockRequest,
  type QuestionDraft,
  questionResolved,
  QuestionSource,
} from './questionDockModel';

const pluginPermission = (questions: unknown[]): CoworkPermissionRequest => ({
  sessionId: 's',
  requestId: 'r',
  toolName: 'AskUserQuestion',
  toolInput: { questions, sessionKey: 'agent:main:lobsterai:s' },
});

const nativePermission = (questions: unknown[], overrides: Record<string, unknown> = {}): CoworkPermissionRequest => ({
  sessionId: 's',
  requestId: 'openclaw-question:q',
  toolName: 'ask_user',
  toolInput: { id: 'q', sessionKey: 'agent:main:lobsterai:s', expiresAtMs: Date.now() + 60_000, status: 'pending', questions, ...overrides },
});

const options = [{ label: 'A (Recommended)' }, { label: 'B', description: 'second' }];

describe('permissionDockRequest', () => {
  test('maps plugin questions with positional ids, explicit ids and free text', () => {
    const request = permissionDockRequest(pluginPermission([
      { question: 'Which?', options },
      { id: 'timing', question: 'When?', options, multiSelect: true },
    ]));
    expect(request).toMatchObject({ key: 's:r', source: QuestionSource.Plugin });
    expect(request).not.toHaveProperty('expiresAt');
    expect(request?.questions).toEqual([
      { id: 'question-1', title: 'Which?', multiSelect: false, allowFreeText: true, options: [
        { id: 'A (Recommended)', label: 'A (Recommended)', description: undefined },
        { id: 'B', label: 'B', description: 'second' },
      ] },
      expect.objectContaining({ id: 'timing', title: 'When?', multiSelect: true, allowFreeText: true }),
    ]);
  });

  test('maps native questions and only allows typed answers where the protocol does', () => {
    const request = permissionDockRequest(nativePermission([
      { questionId: 'style', header: 'Style', question: 'Which style?', options },
      { questionId: 'name', header: 'Name', question: 'Name it?', options: [] },
      { questionId: 'extra', header: 'Extra', question: 'Anything else?', options, isOther: true },
    ]));
    expect(request?.source).toBe(QuestionSource.Native);
    expect(request?.expiresAt).toBeGreaterThan(Date.now());
    expect(request?.questions.map((question) => [question.id, question.allowFreeText])).toEqual([
      ['style', false], ['name', true], ['extra', true],
    ]);
  });

  test('leaves approvals, secret prompts, duplicates and settled native records to the modal', () => {
    expect(permissionDockRequest({ sessionId: 's', requestId: 'r', toolName: 'Bash', toolInput: { command: 'rm -rf' } })).toBeNull();
    expect(permissionDockRequest(pluginPermission([{ question: 'Token?', options, isSecret: true }]))).toBeNull();
    expect(permissionDockRequest(pluginPermission([{ id: 'x', question: 'A?', options }, { id: 'x', question: 'B?', options }]))).toBeNull();
    expect(permissionDockRequest(pluginPermission([]))).toBeNull();
    expect(permissionDockRequest(nativePermission([{ questionId: 'style', header: '', question: 'Which?', options }], { status: 'answered' }))).toBeNull();
    expect(isQuestionDockRequest(pluginPermission([{ question: 'Which?', options }]))).toBe(true);
  });
});

describe('questionResolved', () => {
  test('counts a choice, typed text or an explicit skip', () => {
    expect(questionResolved(emptyQuestionDraft(), 'q')).toBe(false);
    expect(questionResolved({ ...emptyQuestionDraft(), answers: { q: ['A'] } }, 'q')).toBe(true);
    expect(questionResolved({ ...emptyQuestionDraft(), freeText: { q: '  typed ' } }, 'q')).toBe(true);
    expect(questionResolved({ ...emptyQuestionDraft(), freeText: { q: '   ' } }, 'q')).toBe(false);
    expect(questionResolved({ ...emptyQuestionDraft(), skipped: ['q'] }, 'q')).toBe(true);
  });
});

describe('permissionDockAnswer', () => {
  const draft: QuestionDraft = {
    step: 1,
    answers: { 'question-1': ['A (Recommended)', 'B'], timing: [] },
    freeText: { 'question-1': ' later ', timing: '' },
    skipped: ['timing'],
  };

  test('plugin answers keep the question text keys, the ||| separator and skipped ids', () => {
    const permission = pluginPermission([
      { question: 'Which?', options, multiSelect: true },
      { id: 'timing', question: 'When?', options },
    ]);
    expect(permissionDockAnswer(permissionDockRequest(permission)!, draft)).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...permission.toolInput,
        answers: { 'Which?': 'A (Recommended)|||B|||later' },
        skippedQuestionIds: ['timing'],
      },
    });
  });

  test('native answers use questionId -> string[] with typed text as one more value', () => {
    const request = permissionDockRequest(nativePermission([
      { questionId: 'style', header: 'Style', question: 'Which style?', options, multiSelect: true, isOther: true },
      { questionId: 'name', header: 'Name', question: 'Name it?', options: [] },
    ]))!;
    expect(permissionDockAnswer(request, {
      step: 0, answers: { style: ['B'] }, freeText: { style: 'custom', name: ' Lobster ' }, skipped: [],
    })).toEqual({ behavior: 'allow', updatedInput: { answers: { style: ['B', 'custom'], name: ['Lobster'] } } });
  });
});
