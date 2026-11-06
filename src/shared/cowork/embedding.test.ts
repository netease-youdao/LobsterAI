import { expect, test } from 'vitest';

import { EmbeddingProvider, isEmbeddingProvider } from './embedding';

test('isEmbeddingProvider accepts only the configured providers', () => {
  for (const provider of Object.values(EmbeddingProvider)) {
    expect(isEmbeddingProvider(provider)).toBe(true);
  }
  expect(isEmbeddingProvider('cohere')).toBe(false);
  expect(isEmbeddingProvider('')).toBe(false);
  expect(isEmbeddingProvider(undefined)).toBe(false);
});
