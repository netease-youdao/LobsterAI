import { test, expect } from 'vitest';
import { classifyErrorKey } from './coworkErrorClassify';

test('input too long: max_tokens exceeded', () => {
  expect(classifyErrorKey('max_tokens exceeded')).toBe('coworkErrorInputTooLong');
});

test('input too long: max_completion_tokens exceeded', () => {
  expect(classifyErrorKey('max_completion_tokens exceeded for this model')).toBe(
    'coworkErrorInputTooLong'
  );
});

test('input too long: context length exceeded', () => {
  expect(
    classifyErrorKey("This model's maximum context length is 8192 tokens. context length exceeded")
  ).toBe('coworkErrorInputTooLong');
});

test('does not classify bare max_tokens / unsupported param as input too long', () => {
  expect(
    classifyErrorKey("Unsupported parameter: 'max_tokens' is not supported with this model")
  ).toBeNull();
  expect(classifyErrorKey('max_tokens must be a positive integer')).toBeNull();
});
