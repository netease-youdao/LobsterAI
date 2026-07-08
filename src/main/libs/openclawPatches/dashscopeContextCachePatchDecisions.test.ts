import { describe, test } from 'vitest';

import {
  expectBundledOpenClawRuntimeContains,
  expectOpenClawSourceContains,
  expectPatchContains,
  isBundledOpenClawRuntimeAvailable,
  isOpenClawSourceAvailable,
} from './patchTestUtils';

describe('OpenAI-compatible explicit context cache OpenClaw patch decisions', () => {
  test('keeps explicit context cache eligibility and payload coverage', () => {
    expectPatchContains('openclaw-dashscope-context-cache.patch', [
      'contextCacheProvider: "dashscope"',
      'contextCacheProvider: "anthropic-compatible"',
      'contextCacheMode: "explicit"',
      'resolveCacheRetention',
      'resolveExplicitContextCacheStreamParams',
      'applyOpenAICompletionsExplicitContextCache',
      '[ExplicitCachePassThrough]',
      '[ExplicitCachePayload]',
      '********************',
      'adds Anthropic cache_control markers for OpenAI-compatible explicit context cache',
      'cache_control: { type: "ephemeral" }',
      'not OpenAI prompt_cache_key',
    ]);
  });

  test.skipIf(!isOpenClawSourceAvailable())('is applied to the local OpenClaw source tree', () => {
    expectOpenClawSourceContains([
      {
        file: 'src/agents/embedded-agent-runner/prompt-cache-retention.ts',
        snippets: [
          'contextCacheProvider === "dashscope"',
          'contextCacheProvider === "anthropic-compatible"',
          'contextCacheMode === "explicit"',
          'explicitContextCacheEligible',
        ],
      },
      {
        file: 'src/llm/providers/openai-completions.ts',
        snippets: [
          'getCompatCacheControl(compat, cacheRetention, options)',
          'options?.contextCacheProvider === "dashscope"',
          'options?.contextCacheProvider === "anthropic-compatible"',
          'options?.contextCacheMode === "explicit"',
          'isOpenAICompatibleExplicitContextCache(options)',
          '[ExplicitCachePayload]',
          'hasCacheControl=',
          'cache_control: cacheControl',
          'return { type: "ephemeral", ...(ttl ? { ttl } : {}) };',
        ],
      },
      {
        file: 'src/agents/embedded-agent-runner/extra-params.ts',
        snippets: [
          'contextCacheProvider?: "dashscope" | "anthropic-compatible"',
          'contextCacheMode?: "explicit"',
          'resolveExplicitContextCacheStreamParams',
          '[ExplicitCachePassThrough]',
          '...explicitContextCacheParams',
        ],
      },
      {
        file: 'src/agents/openai-transport-stream.ts',
        snippets: [
          'contextCacheProvider?: string',
          'contextCacheMode?: string',
          'isOpenAICompatibleExplicitContextCache',
          'applyOpenAICompletionsExplicitContextCache',
          '[ExplicitCachePayload]',
          'cache_control: cacheControl',
        ],
      },
    ]);
  });

  test.skipIf(!isBundledOpenClawRuntimeAvailable())('is applied to the bundled OpenClaw runtime', () => {
    expectBundledOpenClawRuntimeContains([
      '********************',
      '[ExplicitCachePassThrough]',
      '[ExplicitCachePayload]',
      'reason=cacheRetention-none',
      'cache_control',
      'contextCacheProvider',
      'contextCacheMode',
    ]);
  });
});
