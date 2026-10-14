import type { StreamFn } from 'openclaw/plugin-sdk/agent-core';

import { loadDefaultStreamFn } from './defaultStreamFn';

/**
 * Kimi K3 OpenAI-compatible request contract.
 *
 * OpenClaw v2026.8.1 applies this contract natively, but only for models owned
 * by the bundled Moonshot provider (`provider === "moonshot"`). LobsterAI keeps
 * `custom_N/kimi-k3` and package K3 models under their own provider IDs, so the
 * compatibility owner carries the same rules itself instead of importing a
 * Moonshot-only helper from the plugin SDK. Keep this aligned with upstream
 * `sanitizeAlwaysThinkingPayload` and `ensureMoonshotToolCallReasoningContent`
 * in `src/llm/providers/stream-wrappers/moonshot-thinking.ts`.
 */
export const KIMI_K3_REASONING_EFFORT = 'max';

/** K3 fixes sampling server-side; these request fields must not be sent. */
export const KIMI_K3_FIXED_SAMPLING_FIELDS = [
  'temperature',
  'top_p',
  'n',
  'presence_penalty',
  'frequency_penalty',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

/**
 * K3 rejects replayed assistant tool-call messages that carry no
 * `reasoning_content`, even when the original reasoning was never stored.
 */
export const ensureKimiK3ToolCallReasoningContent = (
  payload: Record<string, unknown>,
): void => {
  if (!Array.isArray(payload.messages)) return;
  for (const message of payload.messages) {
    if (
      !isRecord(message)
      || message.role !== 'assistant'
      || !Array.isArray(message.tool_calls)
      || message.tool_calls.length === 0
      || 'reasoning_content' in message
    ) {
      continue;
    }
    message.reasoning_content = '';
  }
};

export const applyKimiK3PayloadContract = (payload: Record<string, unknown>): void => {
  delete payload.thinking;
  delete payload.reasoningEffort;
  for (const field of KIMI_K3_FIXED_SAMPLING_FIELDS) {
    delete payload[field];
  }
  payload.reasoning_effort = KIMI_K3_REASONING_EFFORT;
  ensureKimiK3ToolCallReasoningContent(payload);
};

/**
 * Wraps a stream function so every outgoing K3 request follows the contract,
 * including payloads a later `onPayload` caller replaces or mutates.
 */
export const createKimiK3StreamWrapper = (baseStreamFn: StreamFn | undefined): StreamFn => {
  return async (model, context, options) => {
    const underlying = baseStreamFn ?? (await loadDefaultStreamFn());
    const originalOnPayload = options?.onPayload;
    return underlying({ ...model, reasoning: true }, context, {
      ...options,
      reasoning: KIMI_K3_REASONING_EFFORT,
      onPayload: (payload, payloadModel) => {
        if (!isRecord(payload)) {
          return originalOnPayload?.(payload, payloadModel);
        }
        applyKimiK3PayloadContract(payload);
        const finish = (result: unknown): unknown => {
          applyKimiK3PayloadContract(isRecord(result) ? result : payload);
          return result;
        };
        const result = originalOnPayload?.(payload, payloadModel);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return Promise.resolve(result).then(finish);
        }
        return finish(result);
      },
    });
  };
};
