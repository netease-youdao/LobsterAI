import { OpenClawProviderId, ProviderName } from '@shared/providers/constants';
import { describe, expect, test } from 'vitest';

import { resolveOpenClawModelRef } from './openclawModelRef';

describe('resolveOpenClawModelRef', () => {
  test('resolves legacy OpenAI Codex refs to the canonical OpenAI provider', () => {
    const model = {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      providerKey: ProviderName.OpenAI,
      openClawProviderId: OpenClawProviderId.OpenAI,
    };

    expect(resolveOpenClawModelRef('openai-codex/gpt-5.4', [model])).toBe(model);
  });

  test('keeps compatibility with old OpenAI OAuth model lists', () => {
    const model = {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      providerKey: ProviderName.OpenAI,
      openClawProviderId: OpenClawProviderId.OpenAICodex,
    };

    expect(resolveOpenClawModelRef('openai/gpt-5.4', [model])).toBe(model);
  });
});
