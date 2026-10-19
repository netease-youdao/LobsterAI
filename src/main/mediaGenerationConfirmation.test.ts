import {
  describe,
  expect,
  test,
} from 'vitest';

import { isMediaGenerationConfirmed } from './mediaGenerationConfirmation';

describe('paid media confirmation', () => {
  test.each([
    null, undefined, {}, { behavior: 'allow' }, { behavior: 'deny', answers: { question: 'Generate' } },
    { behavior: 'allow', answers: { question: 'Cancel' } },
    { behavior: 'allow', answers: { anotherQuestion: 'Generate' } },
    { behavior: 'allow', answers: { question: 'free text' } },
  ])('does not submit without an explicit matching approval: %j', response => {
    expect(isMediaGenerationConfirmed(response, 'question', 'Generate')).toBe(false);
  });

  test('accepts only the actual question and affirmative option', () => {
    expect(isMediaGenerationConfirmed({ behavior: 'allow', answers: { question: 'Generate' } }, 'question', 'Generate'))
      .toBe(true);
  });
});
