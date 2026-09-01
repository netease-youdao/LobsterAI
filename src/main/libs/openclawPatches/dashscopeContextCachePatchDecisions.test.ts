import { describe, test } from 'vitest';

import {
  expectBundledOpenClawRuntimeContains,
  expectCurrentOpenClawPatchMissing,
  expectOpenClawSourceContains,
  expectPatchContains,
  isBundledOpenClawRuntimeAvailable,
  isOpenClawSourceAvailable,
} from './patchTestUtils';

describe('OpenAI-compatible explicit context cache OpenClaw patch decisions', () => {
  test('uses the standard model compat flag instead of LobsterAI-only runtime params', () => {
    expectCurrentOpenClawPatchMissing('openclaw-dashscope-context-cache.patch');
    expectPatchContains('openclaw-openai-compatible-cache-control.patch', [
      'compat: { cacheControlFormat: "anthropic" }',
      'resolveAnthropicCacheControl',
      'applyAnthropicCacheControl',
      'splitSystemPromptCacheBoundary',
      'preserveSystemPromptCacheBoundary: cacheControl !== undefined',
      'cache_control: cacheControl',
      'adds Anthropic cache-control markers for opted-in compatible providers',
    ]);
  });

  test.skipIf(!isOpenClawSourceAvailable())('is applied to the local OpenClaw source tree', () => {
    expectOpenClawSourceContains([
      {
        file: 'packages/ai/src/transports/openai-completions-params.ts',
        snippets: [
          'compat.cacheControlFormat !== "anthropic"',
          'resolveAnthropicCacheControl',
          'applyAnthropicCacheControl',
          'preserveSystemPromptCacheBoundary: cacheControl !== undefined',
          'cache_control = cacheControl',
        ],
      },
      {
        file: 'packages/ai/src/transports/openai-completions-params.cache-and-compat.test.ts',
        snippets: [
          'adds Anthropic cache-control markers for opted-in compatible providers',
          'cacheControlFormat: "anthropic"',
        ],
      },
    ]);
  });

  test.skipIf(!isBundledOpenClawRuntimeAvailable())('is applied to the bundled OpenClaw runtime', () => {
    expectBundledOpenClawRuntimeContains([
      'cacheControlFormat',
      'preserveSystemPromptCacheBoundary',
      'cache_control',
    ]);
  });
});
