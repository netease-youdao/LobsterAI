import { describe, expect, test } from 'vitest';

import { COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS } from '../../../shared/cowork/constants';
import type { CoworkSearchMessage } from '../../../shared/cowork/search';
import { ConversationSearchHistoryLimitKind } from './conversationSearchHistoryLoader';
import {
  findConversationSearchMatchesInBatches,
  reconcileConversationSearchStreamMessages,
} from './useCoworkConversationSearch';

describe('findConversationSearchMatchesInBatches', () => {
  test('keeps main-process absolute indexes when non-searchable timeline rows were projected out', async () => {
    const messages: CoworkSearchMessage[] = [
      {
        id: 'user-at-4',
        type: 'user',
        content: 'needle',
        timestamp: 4,
        absoluteMessageIndex: 4,
      },
      {
        id: 'assistant-at-91',
        type: 'assistant',
        content: 'needle and another needle',
        timestamp: 91,
        absoluteMessageIndex: 91,
      },
    ];

    const result = await findConversationSearchMatchesInBatches(
      messages,
      'needle',
      () => true,
    );

    expect(result?.matches.map(match => match.absoluteMessageIndex)).toEqual([4, 91, 91]);
  });
});

describe('reconcileConversationSearchStreamMessages', () => {
  test('rejects a streamed content update that crosses the per-message budget', () => {
    const historyMessages: CoworkSearchMessage[] = [{
      id: 'streaming-assistant',
      type: 'assistant',
      content: 'partial',
      timestamp: 1,
      absoluteMessageIndex: 3,
    }];

    expect(() => reconcileConversationSearchStreamMessages(historyMessages, [{
      id: 'streaming-assistant',
      type: 'assistant',
      content: 'x'.repeat(COWORK_SEARCH_HISTORY_MAX_MESSAGE_CONTENT_CODE_UNITS + 1),
      timestamp: 2,
    }])).toThrow(expect.objectContaining({
      kind: ConversationSearchHistoryLimitKind.MessageContentCodeUnits,
    }));
  });
});
