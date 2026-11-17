import { describe, expect, test } from 'vitest';

import { readHomeExamplesCollapsed, rememberHomeExamplesCollapsed } from './homeExamplesPreference';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('homeExamplesPreference', () => {
  test('shows examples until the user closes them', () => {
    const storage = memoryStorage();
    expect(readHomeExamplesCollapsed(storage)).toBe(false);
    rememberHomeExamplesCollapsed(true, storage);
    expect(readHomeExamplesCollapsed(storage)).toBe(true);
  });

  test('reopening clears the remembered choice', () => {
    const storage = memoryStorage();
    rememberHomeExamplesCollapsed(true, storage);
    rememberHomeExamplesCollapsed(false, storage);
    expect(readHomeExamplesCollapsed(storage)).toBe(false);
  });

  test('falls back to showing examples when storage is unavailable', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(() => rememberHomeExamplesCollapsed(true, broken)).not.toThrow();
    expect(readHomeExamplesCollapsed(broken)).toBe(false);
    expect(readHomeExamplesCollapsed(null)).toBe(false);
  });
});
