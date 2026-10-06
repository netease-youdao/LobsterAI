import type { StreamFn } from 'openclaw/plugin-sdk/agent-core';
import { describe, expect, test } from 'vitest';

import {
  createLobsterAIRequestOptionsWrapper,
  resolveLobsterAIRequestThinkingLevel,
} from '../../../openclaw-extensions/lobsterai-model-compat/requestOptions';
import {
  LOBSTERAI_REQUEST_OPTIONS_FIELD,
  LOBSTERAI_REQUEST_OPTIONS_VERSION,
} from '../../../openclaw-extensions/lobsterai-model-compat/requestOptionsProtocol';
import type { LobsterAIThinkingProfile } from '../../../openclaw-extensions/lobsterai-model-compat/thinkingProfileMapping';

const profile: LobsterAIThinkingProfile = {
  options: [
    { level: 'off', openclawLevel: 'off' },
    { level: 'high', openclawLevel: 'high' },
    { level: 'max', openclawLevel: 'xhigh' },
  ],
  defaultLevel: 'high',
  requestOptionsVersion: 1,
};

describe('LobsterAI request options', () => {
  test('uses an allowed selected level and falls back to the profile default', () => {
    expect(resolveLobsterAIRequestThinkingLevel(profile, 'off')).toBe('off');
    expect(resolveLobsterAIRequestThinkingLevel(profile, 'xhigh')).toBe('max');
    expect(resolveLobsterAIRequestThinkingLevel(profile, 'low')).toBe('high');
    expect(resolveLobsterAIRequestThinkingLevel(profile, undefined)).toBe('high');
  });

  test('adds the final semantic thinking intent after the caller payload hook', async () => {
    let forwardedOptions: Parameters<StreamFn>[2] | undefined;
    const baseStreamFn: StreamFn = ((_model, _context, options) => {
      forwardedOptions = options;
      return {} as ReturnType<StreamFn>;
    }) as StreamFn;
    const wrapped = createLobsterAIRequestOptionsWrapper(baseStreamFn, 'off');

    await wrapped({} as never, {} as never, {
      onPayload: () => ({
        model: 'deepseek-v4-flash-YoudaoInner',
        [LOBSTERAI_REQUEST_OPTIONS_FIELD]: {
          version: 999,
          thinking: { level: 'max' },
        },
      }),
    });

    const payload = await forwardedOptions?.onPayload?.({}, {} as never);
    expect(payload).toEqual({
      model: 'deepseek-v4-flash-YoudaoInner',
      [LOBSTERAI_REQUEST_OPTIONS_FIELD]: {
        version: LOBSTERAI_REQUEST_OPTIONS_VERSION,
        thinking: { level: 'off' },
      },
    });
  });
});
