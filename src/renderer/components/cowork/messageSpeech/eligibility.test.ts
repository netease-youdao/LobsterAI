import { expect, test } from 'vitest';

import { CoworkSystemMessageKind } from '../../../../common/coworkSystemMessages';
import { CoworkTurnOutcome } from '../../../../shared/cowork/turnOutcome';
import { type CoworkMessage, type CoworkMessageMetadata, CoworkSessionStatusValue } from '../../../types/cowork';
import { buildConversationTurns, buildDisplayItems, type ConversationTurn } from '../messageDisplayUtils';
import { getLastMessageSpeechTurnIndex, isMessageSpeechTurnCompleted } from './eligibility';

const turn = (metadata?: CoworkMessageMetadata, replyMetadata?: CoworkMessageMetadata): ConversationTurn => ({
  id: 'user',
  userMessage: { id: 'user', type: 'user', content: 'question', timestamp: 1, metadata },
  assistantItems: [{ type: 'assistant', message: { id: 'reply', type: 'assistant', content: 'answer', timestamp: 2, metadata: replyMetadata } }],
});
const context = {
  isLastTurn: true,
  sessionStatus: CoworkSessionStatusValue.Completed,
  isStreaming: false,
  hasRunningSubagents: false,
};

test('a recorded completed reply remains readable after a later turn starts or fails', () => {
  const completed = turn({ turnOutcome: CoworkTurnOutcome.Completed });
  expect(isMessageSpeechTurnCompleted(completed, { ...context, isLastTurn: false, isStreaming: true })).toBe(true);
  expect(isMessageSpeechTurnCompleted(completed, { ...context, isLastTurn: false, sessionStatus: CoworkSessionStatusValue.Error })).toBe(true);
});

test.each([CoworkTurnOutcome.Stopped, CoworkTurnOutcome.Failed])('never offers a %s turn even if the session later completes', outcome => {
  expect(isMessageSpeechTurnCompleted(turn({ turnOutcome: outcome }, { isFinal: true }), context)).toBe(false);
});

test.each(['isError', 'isTimeout', 'isIncomplete', 'isTruncated', 'isStreaming'])('excludes replies marked %s', flag => {
  expect(isMessageSpeechTurnCompleted(turn({ turnOutcome: CoworkTurnOutcome.Completed }, { [flag]: true }), context)).toBe(false);
});

test('hides speech until the current run and its child work finish', () => {
  const completed = turn({ turnOutcome: CoworkTurnOutcome.Completed });
  expect(isMessageSpeechTurnCompleted(completed, { ...context, isStreaming: true })).toBe(false);
  expect(isMessageSpeechTurnCompleted(completed, { ...context, hasRunningSubagents: true })).toBe(false);
});

test('accepts legacy terminal success but never guesses an older final message was successful', () => {
  const legacy = turn(undefined, { isFinal: true });
  expect(isMessageSpeechTurnCompleted(legacy, context)).toBe(true);
  expect(isMessageSpeechTurnCompleted(legacy, { ...context, isLastTurn: false })).toBe(false);
  expect(isMessageSpeechTurnCompleted(legacy, { ...context, sessionStatus: CoworkSessionStatusValue.Idle })).toBe(false);
});

test('a paged reply can use its own recorded outcome when its user message is outside the page', () => {
  const paged = { ...turn(undefined, { turnOutcome: CoworkTurnOutcome.Completed }), userMessage: null };
  expect(isMessageSpeechTurnCompleted(paged, { ...context, isLastTurn: false })).toBe(true);
});

const legacyMessages: CoworkMessage[] = [
  { id: 'user', type: 'user', content: 'question', timestamp: 1 },
  { id: 'reply', type: 'assistant', content: 'answer', timestamp: 2, metadata: { isFinal: true } },
];
const modelNotice = (id: string): CoworkMessage => ({
  id, type: 'system', content: '', timestamp: 3,
  metadata: { kind: CoworkSystemMessageKind.ModelChanged,
    modelChange: { previousModelRef: 'provider/old', nextModelRef: 'provider/new' } },
});
const speechEligibility = (messages: CoworkMessage[], overrides = {}) => {
  const turns = buildConversationTurns(buildDisplayItems(messages));
  const lastTurnIndex = getLastMessageSpeechTurnIndex(turns);
  return turns.map((item, index) => isMessageSpeechTurnCompleted(item, {
    ...context, ...overrides, isLastTurn: index === lastTurnIndex,
  }));
};

test('legacy completed replies remain readable through repeated model changes', () => {
  expect(speechEligibility(legacyMessages)).toEqual([true]);
  expect(speechEligibility([...legacyMessages, modelNotice('switch-1'), modelNotice('switch-2')]))
    .toEqual([true, false, false]);
  expect(speechEligibility([modelNotice('switch-only')])).toEqual([false]);
  expect(getLastMessageSpeechTurnIndex([])).toBe(-1);
});

test('model notices never make a stopped, failed or currently running legacy reply readable', () => {
  const messages = [...legacyMessages, modelNotice('switch')];
  for (const sessionStatus of [CoworkSessionStatusValue.Idle, CoworkSessionStatusValue.Error]) {
    expect(speechEligibility(messages, { sessionStatus })).toEqual([false, false]);
  }
  expect(speechEligibility(messages, { isStreaming: true })).toEqual([false, false]);
});

test('a later execution or error still prevents inferring success for an older legacy reply', () => {
  const messages = [...legacyMessages, modelNotice('switch')];
  expect(speechEligibility([...messages, { id: 'next', type: 'user', content: 'continue', timestamp: 4 }]))
    .toEqual([false, false, false]);
  expect(speechEligibility([...messages, { id: 'error', type: 'system', content: 'failed', timestamp: 4,
    metadata: { isError: true } }])).toEqual([false, false, false]);
});
