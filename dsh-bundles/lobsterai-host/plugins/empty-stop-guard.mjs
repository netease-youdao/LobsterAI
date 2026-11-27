/**
 * @lobsterai/dsh-bundle — Empty / Reasoning-Only Stop Guard
 *
 * Some OpenAI-compatible reasoning models (including proxied DeepSeek routes)
 * occasionally terminate a turn prematurely with `finish_reason: "stop"` after
 * streaming only a partial `reasoning_content` block and zero visible text or
 * tool calls. DSH's `dsh-llm-pi-ai` only classifies zero-block completions as
 * `EMPTY_RESPONSE`, letting reasoning-only premature stops end the turn blank.
 *
 * This wrapper inspects each `llm/stream` attempt and reclassifies any `stop`
 * completion that produced neither non-whitespace text nor any tool call /
 * non-reasoning block as a retryable `EMPTY_RESPONSE` error so `dsh-llm-retry`
 * automatically retries the step without polluting conversation history.
 */

export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE';

export const DEFAULT_LOBSTER_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: [
    EMPTY_RESPONSE_CODE,
    'STREAM_CLOSED',
    'MALFORMED_RESPONSE',
    'RATE_LIMIT',
    'SERVER',
    'TIMEOUT',
    'TRANSPORT',
  ],
});

/**
 * Determine whether a single `StreamChunk` carries actionable non-reasoning
 * output (visible non-whitespace text, a tool call, or another non-reasoning
 * content block such as image/file).
 */
export function chunkHasActionableOutput(chunk) {
  if (!chunk || typeof chunk !== 'object') return false;
  switch (chunk.type) {
    case 'text-delta':
      return typeof chunk.text === 'string' && chunk.text.trim().length > 0;
    case 'tool-call-delta':
      return true;
    case 'block-start':
      return typeof chunk.blockType === 'string'
        && chunk.blockType !== 'reasoning'
        && chunk.blockType !== 'text';
    case 'block-end': {
      const block = chunk.block;
      if (!block || typeof block !== 'object') return false;
      if (block.type === 'reasoning') return false;
      if (block.type === 'text') {
        return typeof block.text === 'string' && block.text.trim().length > 0;
      }
      return typeof block.type === 'string';
    }
    default:
      return false;
  }
}

/**
 * Wrap one DSH `llm/stream` async iterable so a `finish` chunk with
 * `reason.kind === 'stop'` and zero actionable output becomes a retryable
 * `EMPTY_RESPONSE` error finish chunk.
 */
export async function* guardEmptyStopStream(source, options, logger) {
  let hasActionableOutput = false;
  let hasReasoningOutput = false;

  for await (const chunk of source) {
    if (chunk && typeof chunk === 'object') {
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        hasReasoningOutput = true;
      } else if (
        chunk.type === 'block-end'
        && chunk.block?.type === 'reasoning'
        && typeof chunk.block.text === 'string'
        && chunk.block.text.length > 0
      ) {
        hasReasoningOutput = true;
      }
      if (!hasActionableOutput && chunkHasActionableOutput(chunk)) {
        hasActionableOutput = true;
      }

      if (
        chunk.type === 'finish'
        && chunk.reason?.kind === 'stop'
        && !hasActionableOutput
      ) {
        const provider = options?.provider ?? 'unknown';
        const model = options?.model ?? 'unknown';
        const detail = hasReasoningOutput
          ? 'reasoning-only stop with no visible text or tool calls'
          : 'empty stop with no visible text or tool calls';
        logger?.warn?.(
          `[LobsterAI:ModelBridge] ${detail} from "${provider}/${model}"; reclassifying as ${EMPTY_RESPONSE_CODE} for automatic retry`,
        );
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: `model "${model}" returned a completed response with no visible text or tool calls`,
              code: EMPTY_RESPONSE_CODE,
            },
          },
        };
        continue;
      }
    }
    yield chunk;
  }
}
