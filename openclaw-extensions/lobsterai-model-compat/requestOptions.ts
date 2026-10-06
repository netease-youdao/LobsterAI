import type { StreamFn } from 'openclaw/plugin-sdk/agent-core';

import { loadDefaultStreamFn } from './defaultStreamFn';
import {
  LOBSTERAI_REQUEST_OPTIONS_FIELD,
  LOBSTERAI_REQUEST_OPTIONS_VERSION,
} from './requestOptionsProtocol';
import type {
  LobsterAIThinkingLevel,
  LobsterAIThinkingProfile,
} from './thinkingProfileMapping';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

export const resolveLobsterAIRequestThinkingLevel = (
  profile: LobsterAIThinkingProfile,
  requestedLevel: string | undefined,
): LobsterAIThinkingLevel => (
  profile.options.find(option => option.openclawLevel === requestedLevel)?.level
    ?? profile.defaultLevel
);

const applyRequestOptions = (
  payload: unknown,
  thinkingLevel: LobsterAIThinkingLevel,
): unknown => {
  if (!isRecord(payload)) return payload;
  payload[LOBSTERAI_REQUEST_OPTIONS_FIELD] = {
    version: LOBSTERAI_REQUEST_OPTIONS_VERSION,
    thinking: {
      level: thinkingLevel,
    },
  };
  return payload;
};

export const createLobsterAIRequestOptionsWrapper = (
  baseStreamFn: StreamFn | undefined,
  thinkingLevel: LobsterAIThinkingLevel,
): StreamFn => {
  return async (model, context, options) => {
    const underlying = baseStreamFn ?? (await loadDefaultStreamFn());
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload, payloadModel) => {
        const result = originalOnPayload?.(payload, payloadModel);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return Promise.resolve(result).then(resolved => (
            applyRequestOptions(resolved ?? payload, thinkingLevel)
          ));
        }
        return applyRequestOptions(result ?? payload, thinkingLevel);
      },
    });
  };
};
