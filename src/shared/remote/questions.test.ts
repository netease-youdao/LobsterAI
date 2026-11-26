import { expect, test } from 'vitest';

import { parseQuestionAnswers, parseRemoteQuestionItems } from './questions';

const items = [{ questionId: 'q_0', header: 'h', question: 'q', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, isOther: false, allowSkip: false }];
test('canonical forms and exact labels survive without secrets or forged IDs', () => {
  expect(parseRemoteQuestionItems(items)).toEqual(items);
  expect(parseRemoteQuestionItems([{ ...items[0], isSecret: true }])).toBeNull();
  expect(parseRemoteQuestionItems([{ ...items[0], secretStore: {} }])).toBeNull();
  expect(parseRemoteQuestionItems([{ ...items[0], questionId: 'raw:gateway' }])).toBeNull();
  expect(parseRemoteQuestionItems([{ ...items[0], question: '字'.repeat(1500) }])).toBeNull();
});
test('normal forms reject duplicate options and enforce bounds by UTF8 bytes', () => {
  expect(parseRemoteQuestionItems([{ ...items[0], options: [{ label: 'A' }, { label: 'A' }] }])).toBeNull();
  expect(parseRemoteQuestionItems(Array.from({ length: 5 }, (_, i) => ({ ...items[0], questionId: `q_${i}` })))).toBeNull();
  expect(parseRemoteQuestionItems([{ ...items[0], options: [], isOther: false }])?.[0].isOther).toBe(true);
});
test('answers require exact item keys, allowed labels and explicit optional skip', () => {
  expect(parseQuestionAnswers(items, { q_0: ['A'] })).toEqual({ q_0: ['A'] });
  for (const value of [{ q_0: [] }, { q_0: ['A', 'B'] }, { q_0: ['X'] }, { q_0: ['A'], injected: ['B'] }, { wrong: ['A'] }]) expect(parseQuestionAnswers(items, value)).toBeNull();
  expect(parseQuestionAnswers([{ ...items[0], allowSkip: true }], { q_0: [] })).toEqual({ q_0: [] });
});
test('other is one bounded string and never split by a native multiselect separator', () => {
  const form = [{ ...items[0], multiSelect: true, isOther: true }];
  expect(parseQuestionAnswers(form, { q_0: ['A', 'custom|||value'] })).toEqual({ q_0: ['A', 'custom|||value'] });
  expect(parseQuestionAnswers(form, { q_0: ['first', 'second'] })).toBeNull();
  expect(parseQuestionAnswers(form, { q_0: ['字'.repeat(1400)] })).toBeNull();
});

test('registration reserves terminal-answer space instead of publishing forms whose results cannot fit', () => {
  const compact = Array.from({ length: 4 }, (_, index) => ({ ...items[0], questionId: `q_${index}`, question: 'x'.repeat(3300) }));
  const crowded = compact.map(item => ({ ...item, question: 'x'.repeat(3600) }));
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(14 * 1024);
  expect(Buffer.byteLength(JSON.stringify(crowded))).toBeGreaterThan(14 * 1024);
  expect(parseRemoteQuestionItems(compact)).not.toBeNull();
  expect(parseRemoteQuestionItems(crowded)).toBeNull();
  // Rejected registration does not mutate or truncate the original local question.
  expect(crowded[0].question.length).toBe(3600);
});
