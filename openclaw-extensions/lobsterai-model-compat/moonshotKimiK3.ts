import type { StreamFn } from 'openclaw/plugin-sdk/agent-core';

const KIMI_K3_REASONING_EFFORT = 'max';
const FIXED_SAMPLING_FIELDS = [
  'temperature',
  'top_p',
  'n',
  'presence_penalty',
  'frequency_penalty',
] as const;

const asPayloadRecord = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

const loadDefaultStreamFn = async (): Promise<StreamFn> => {
  const { streamSimple } = await import('openclaw/plugin-sdk/llm');
  return streamSimple as StreamFn;
};

const sanitizePayload = (payload: Record<string, unknown>): void => {
  delete payload.thinking;
  delete payload.reasoningEffort;
  payload.reasoning_effort = KIMI_K3_REASONING_EFFORT;
  for (const field of FIXED_SAMPLING_FIELDS) {
    delete payload[field];
  }
  if (!Array.isArray(payload.messages)) return;
  for (const message of payload.messages) {
    const record = asPayloadRecord(message);
    if (
      record?.role === 'assistant'
      && Array.isArray(record.tool_calls)
      && record.tool_calls.length > 0
      && !('reasoning_content' in record)
    ) {
      record.reasoning_content = '';
    }
  }
};

/**
 * Keeps the explicit-profile policy from
 * scripts/patches/v2026.6.1/openclaw-kimi-k3-support.patch.
 * That patch's SDK export was retired in v2026.8.1; the upstream replacement
 * recognizes native Moonshot names, while these profiles also cover model aliases.
 */
export const createMoonshotKimiK3Wrapper = (
  baseStreamFn: StreamFn | undefined,
): StreamFn => {
  return async (model, context, options) => {
    const underlying = baseStreamFn ?? (await loadDefaultStreamFn());
    const originalOnPayload = options?.onPayload;
    return underlying({ ...model, reasoning: true }, context, {
      ...options,
      reasoning: KIMI_K3_REASONING_EFFORT,
      onPayload: (payload, payloadModel) => {
        const record = asPayloadRecord(payload);
        if (!record) return originalOnPayload?.(payload, payloadModel);
        sanitizePayload(record);
        const finish = (result: unknown): unknown => {
          sanitizePayload(asPayloadRecord(result) ?? record);
          return result;
        };
        const result = originalOnPayload?.(payload, payloadModel);
        return result && typeof (result as Promise<unknown>).then === 'function'
          ? Promise.resolve(result).then(finish)
          : finish(result);
      },
    });
  };
};
