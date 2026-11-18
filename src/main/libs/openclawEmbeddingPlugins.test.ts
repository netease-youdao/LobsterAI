import { describe, expect, test } from 'vitest';

import { EmbeddingProvider } from '../../shared/cowork/embedding';
import { OpenClawEmbeddingPluginId, resolveOpenClawEmbeddingProvider } from './openclawEmbeddingPlugins';

describe('resolveOpenClawEmbeddingProvider', () => {
  test('keeps every remote provider offered in Settings', () => {
    for (const provider of Object.keys(OpenClawEmbeddingPluginId)) {
      expect(resolveOpenClawEmbeddingProvider(provider)).toBe(provider);
    }
  });

  test('falls back to OpenAI for local, unknown and inherited names', () => {
    expect(resolveOpenClawEmbeddingProvider(EmbeddingProvider.Local)).toBe(EmbeddingProvider.OpenAI);
    expect(resolveOpenClawEmbeddingProvider('cohere')).toBe(EmbeddingProvider.OpenAI);
    expect(resolveOpenClawEmbeddingProvider('toString')).toBe(EmbeddingProvider.OpenAI);
  });
});
