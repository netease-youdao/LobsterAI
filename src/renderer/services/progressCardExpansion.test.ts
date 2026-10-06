import { afterEach, expect, test } from 'vitest';

import { readProgressCardExpanded, rememberProgressCardExpanded } from './progressCardExpansion';

function installLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
  };
  return store;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

test('the card is folded until the user opens it, and stays the way the user left it', () => {
  installLocalStorage();
  expect(readProgressCardExpanded()).toBe(false);

  rememberProgressCardExpanded(true);
  expect(readProgressCardExpanded()).toBe(true);

  rememberProgressCardExpanded(false);
  expect(readProgressCardExpanded()).toBe(false);
});

test('unreadable storage falls back to folded without throwing', () => {
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    },
  };
  expect(() => rememberProgressCardExpanded(true)).not.toThrow();
  expect(readProgressCardExpanded()).toBe(false);
});
