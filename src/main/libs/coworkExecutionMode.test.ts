import { expect, test } from 'vitest';
import { mapExecutionModeToSandboxMode, normalizeCoworkExecutionMode } from './coworkExecutionMode';

test('normalizeCoworkExecutionMode returns persisted values unchanged', () => {
  expect(normalizeCoworkExecutionMode('local')).toBe('local');
  expect(normalizeCoworkExecutionMode('auto')).toBe('auto');
  expect(normalizeCoworkExecutionMode('sandbox')).toBe('sandbox');
});

test('normalizeCoworkExecutionMode falls back to local for invalid values', () => {
  expect(normalizeCoworkExecutionMode(undefined)).toBe('local');
  expect(normalizeCoworkExecutionMode(null)).toBe('local');
  expect(normalizeCoworkExecutionMode('container')).toBe('local');
});

test('mapExecutionModeToSandboxMode preserves the documented sandbox mapping', () => {
  expect(mapExecutionModeToSandboxMode('local')).toBe('off');
  expect(mapExecutionModeToSandboxMode('auto')).toBe('non-main');
  expect(mapExecutionModeToSandboxMode('sandbox')).toBe('all');
});
