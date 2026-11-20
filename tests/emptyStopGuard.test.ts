import { describe, expect, test, vi } from 'vitest';

// Pure ESM guard module inside LobsterAI's DSH host bundle.
import {
  DEFAULT_LOBSTER_RETRY_POLICY,
  EMPTY_RESPONSE_CODE,
  guardEmptyStopStream,
} from '../dsh-bundles/lobsterai-host/plugins/empty-stop-guard.mjs';

async function collectChunks(chunks: unknown[], options = { provider: 'lobsterai-server', model: 'deepseek-flash' }) {
  const logger = { warn: vi.fn() };
  async function* source() {
    for (const chunk of chunks) {
      yield chunk;
    }
  }
  const output: unknown[] = [];
  for await (const chunk of guardEmptyStopStream(source(), options, logger)) {
    output.push(chunk);
  }
  return { output, logger };
}

describe('guardEmptyStopStream', () => {
  test('reclassifies reasoning-only premature stop into retryable EMPTY_RESPONSE error', async () => {
    const { output, logger } = await collectChunks([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'User asks about Vietnam. Fetch CN' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'User asks about Vietnam. Fetch CN' } },
      { type: 'usage', usage: { inputTokens: 256, outputTokens: 18, totalTokens: 35090 } },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: { response: { stopReason: 'stop' } },
      },
    ]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(output[output.length - 1]).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: EMPTY_RESPONSE_CODE,
          message: 'model "deepseek-flash" returned a completed response with no visible text or tool calls',
        },
      },
    });
  });

  test('reclassifies whitespace-only text stop into retryable EMPTY_RESPONSE error', async () => {
    const { output } = await collectChunks([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '   \n\t ' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '   \n\t ' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);

    expect(output[output.length - 1]).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: EMPTY_RESPONSE_CODE } },
    });
  });

  test('passes normal reasoning + visible text stop through unchanged', async () => {
    const finish = { type: 'finish', reason: { kind: 'stop' }, replayState: { ok: true } };
    const { output, logger } = await collectChunks([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Thinking...' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Thinking...' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '越南使用越南盾（VND）。' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '越南使用越南盾（VND）。' } },
      finish,
    ]);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(output[output.length - 1]).toEqual(finish);
  });

  test('passes reasoning + tool-call step through unchanged even if finish reason is stop', async () => {
    const finish = { type: 'finish', reason: { kind: 'stop' } };
    const { output, logger } = await collectChunks([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Need to run curl' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Need to run curl' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'c1', name: 'bash', argumentsDelta: '{"command":"curl"}' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"curl"}' } },
      finish,
    ]);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(output[output.length - 1]).toEqual(finish);
  });

  test('passes max-tokens finish through unchanged without converting to EMPTY_RESPONSE', async () => {
    const finish = { type: 'finish', reason: { kind: 'max-tokens' } };
    const { output, logger } = await collectChunks([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Very long reasoning...' },
      finish,
    ]);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(output[output.length - 1]).toEqual(finish);
  });

  test('DEFAULT_LOBSTER_RETRY_POLICY retries EMPTY_RESPONSE, STREAM_CLOSED, and MALFORMED_RESPONSE', () => {
    expect(DEFAULT_LOBSTER_RETRY_POLICY.mode).toBe('normal');
    expect(DEFAULT_LOBSTER_RETRY_POLICY.maxRetries).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_LOBSTER_RETRY_POLICY.retryableCodes).toContain(EMPTY_RESPONSE_CODE);
    expect(DEFAULT_LOBSTER_RETRY_POLICY.retryableCodes).toContain('STREAM_CLOSED');
    expect(DEFAULT_LOBSTER_RETRY_POLICY.retryableCodes).toContain('MALFORMED_RESPONSE');
  });
});
