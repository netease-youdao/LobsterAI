import { describe, expect, test, vi } from 'vitest';

import { OpenClawGatewayMethod } from './constants';
import {
  hasTruncatedHistoryMessages,
  isTruncatedHistoryPreviewOf,
  OPENCLAW_FULL_MESSAGE_MAX_CHARS,
  OPENCLAW_HISTORY_TRUNCATION_MARKER,
  OpenClawTruncatedHistoryRestorer,
  readTruncatedHistoryMessageId,
} from './openclawTruncatedHistory';

const SESSION_KEY = 'agent:main:lobsterai:session-1';

const preview = (id: string, text: string, role = 'assistant') => ({
  role,
  content: [{ type: 'text', text: `${text}\n${OPENCLAW_HISTORY_TRUNCATION_MARKER}` }],
  __openclaw: { id, truncated: true, reason: 'display-cap' },
});

const full = (id: string, text: string, role = 'assistant') => ({
  role,
  content: [{ type: 'text', text }],
  __openclaw: { id },
});

describe('readTruncatedHistoryMessageId', () => {
  test('returns the id of truncated user and assistant messages only', () => {
    expect(readTruncatedHistoryMessageId(preview('a1', 'x'))).toBe('a1');
    expect(readTruncatedHistoryMessageId(preview('u1', 'x', 'user'))).toBe('u1');
    expect(readTruncatedHistoryMessageId(preview('t1', 'x', 'toolResult'))).toBeUndefined();
    expect(readTruncatedHistoryMessageId(full('a2', 'x'))).toBeUndefined();
    expect(readTruncatedHistoryMessageId({ role: 'assistant', __openclaw: { truncated: true } })).toBeUndefined();
    expect(readTruncatedHistoryMessageId(null)).toBeUndefined();
  });
});

describe('hasTruncatedHistoryMessages', () => {
  test('detects arrays containing a truncated user or assistant message', () => {
    expect(hasTruncatedHistoryMessages([full('u1', 'hi', 'user'), preview('a1', 'x')])).toBe(true);
    expect(hasTruncatedHistoryMessages([full('u1', 'hi', 'user'), full('a1', 'x')])).toBe(false);
    expect(hasTruncatedHistoryMessages(undefined)).toBe(false);
  });
});

describe('isTruncatedHistoryPreviewOf', () => {
  test('matches a capped preview whose prefix the full text extends', () => {
    expect(isTruncatedHistoryPreviewOf(`line 1\nline 2\n${OPENCLAW_HISTORY_TRUNCATION_MARKER}`, 'line 1\nline 2\nline 3')).toBe(true);
  });

  test('rejects text without the marker or with a diverging prefix', () => {
    expect(isTruncatedHistoryPreviewOf('line 1', 'line 1\nline 2')).toBe(false);
    expect(isTruncatedHistoryPreviewOf(`other\n${OPENCLAW_HISTORY_TRUNCATION_MARKER}`, 'line 1\nline 2')).toBe(false);
    expect(isTruncatedHistoryPreviewOf(`line 1\n${OPENCLAW_HISTORY_TRUNCATION_MARKER}`, 'line 1')).toBe(false);
    expect(isTruncatedHistoryPreviewOf(OPENCLAW_HISTORY_TRUNCATION_MARKER, 'anything')).toBe(false);
  });
});

describe('OpenClawTruncatedHistoryRestorer', () => {
  test('returns the same array without requests when nothing is truncated', async () => {
    const request = vi.fn();
    const messages = [full('u1', 'hi', 'user'), full('a1', 'hello')];

    const restored = await new OpenClawTruncatedHistoryRestorer().restore(request, SESSION_KEY, messages);

    expect(restored).toBe(messages);
    expect(request).not.toHaveBeenCalled();
  });

  test('replaces truncated previews with full rows from chat.message.get', async () => {
    const fullAssistant = full('a1', 'complete reply');
    const request = vi.fn(async () => ({ ok: true, message: fullAssistant }));
    const messages = [full('u1', 'hi', 'user'), preview('a1', 'complete')];

    const restored = await new OpenClawTruncatedHistoryRestorer().restore(request, SESSION_KEY, messages);

    expect(restored).toEqual([messages[0], fullAssistant]);
    expect(messages[1]).toEqual(preview('a1', 'complete'));
    expect(request).toHaveBeenCalledWith(
      OpenClawGatewayMethod.ChatMessageGet,
      { sessionKey: SESSION_KEY, messageId: 'a1', maxChars: OPENCLAW_FULL_MESSAGE_MAX_CHARS },
      { timeoutMs: 5_000 },
    );
  });

  test('caches fetched rows and definitive misses per session', async () => {
    const request = vi.fn(async (_method: string, params?: unknown) => {
      const { messageId } = params as { messageId: string };
      return messageId === 'a1'
        ? { ok: true, message: full('a1', 'complete reply') }
        : { ok: false, unavailableReason: 'oversized' };
    });
    const restorer = new OpenClawTruncatedHistoryRestorer();
    const messages = [preview('a1', 'complete'), preview('a2', 'huge')];

    await restorer.restore(request, SESSION_KEY, messages);
    const restored = await restorer.restore(request, SESSION_KEY, messages);

    expect(request).toHaveBeenCalledTimes(2);
    expect(restored).toEqual([full('a1', 'complete reply'), messages[1]]);

    await restorer.restore(request, 'agent:main:lobsterai:session-2', messages);
    expect(request).toHaveBeenCalledTimes(4);
  });

  test('keeps previews and retries later when the request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const request = vi.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ ok: true, message: full('a1', 'complete reply') });
      const restorer = new OpenClawTruncatedHistoryRestorer();
      const messages = [preview('a1', 'complete')];

      expect(await restorer.restore(request, SESSION_KEY, messages)).toEqual(messages);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(await restorer.restore(request, SESSION_KEY, messages)).toEqual([full('a1', 'complete reply')]);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('fetches at most 16 uncached rows per call, newest first', async () => {
    const request = vi.fn(async (_method: string, params?: unknown) => {
      const { messageId } = params as { messageId: string };
      return { ok: true, message: full(messageId, `full ${messageId}`) };
    });
    const messages = Array.from({ length: 20 }, (_, index) => preview(`a${index}`, `part ${index}`));

    const restored = await new OpenClawTruncatedHistoryRestorer().restore(request, SESSION_KEY, messages);

    expect(request).toHaveBeenCalledTimes(16);
    expect(restored.slice(0, 4)).toEqual(messages.slice(0, 4));
    expect(restored.at(-1)).toEqual(full('a19', 'full a19'));
  });
});
