import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  logConversationSearchDebug,
  logConversationSearchWarning,
} from './conversationSearchLogger';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('conversation search renderer logging', () => {
  test('persists only safe event and error categories', () => {
    const fromRenderer = vi.fn();
    const secret = 'private-query-and-message-content';
    vi.stubGlobal('window', { electron: { log: { fromRenderer } } });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    logConversationSearchWarning(
      'Failed to load conversation history.',
      new TypeError(`Network request contained ${secret}`),
    );

    expect(fromRenderer).toHaveBeenCalledWith(
      'warn',
      'ConversationSearch',
      'eventCategory=history; errorType=TypeError; errorCategory=network',
    );
    expect(fromRenderer.mock.calls.flat().join(' ')).not.toContain(secret);
    expect(fromRenderer.mock.calls.flat().join(' ')).not.toContain('Network request contained');
  });

  test('does not persist arbitrary caller text that could contain a query or content', () => {
    const fromRenderer = vi.fn();
    const secret = 'query=customer-secret content=private-transcript';
    vi.stubGlobal('window', { electron: { log: { fromRenderer } } });
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    logConversationSearchDebug(secret);

    expect(fromRenderer).toHaveBeenCalledWith(
      'debug',
      'ConversationSearch',
      'eventCategory=other',
    );
    expect(fromRenderer.mock.calls.flat().join(' ')).not.toContain('customer-secret');
    expect(fromRenderer.mock.calls.flat().join(' ')).not.toContain('private-transcript');
  });

  test('handles thrown values without reading unsafe object serialization', () => {
    const fromRenderer = vi.fn();
    vi.stubGlobal('window', { electron: { log: { fromRenderer } } });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    logConversationSearchWarning('Failed to apply browser search highlights.', {
      message: 'invalid range with private content',
      content: 'must-not-be-persisted',
    });

    expect(fromRenderer).toHaveBeenCalledWith(
      'warn',
      'ConversationSearch',
      'eventCategory=highlight; errorType=object; errorCategory=invalid-data',
    );
    expect(fromRenderer.mock.calls.flat().join(' ')).not.toContain('must-not-be-persisted');
    expect(fromRenderer.mock.calls.flat().join(' ')).not.toContain('private content');
  });
});
