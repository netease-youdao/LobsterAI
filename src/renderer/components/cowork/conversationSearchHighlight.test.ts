import { afterEach, describe, expect, test, vi } from 'vitest';

import { registerVirtualSearchText } from '../../utils/searchDomProjection';
import { CONVERSATION_SEARCH_MATCH_LIMIT } from './conversationSearch';
import {
  applyConversationSearchHighlights,
  getConversationSearchRanges,
} from './conversationSearchHighlight';

class FakeTextNode {
  readonly parentElement = {
    closest: () => null,
  };

  constructor(readonly data: string) {}
}

class FakeRange {
  startOffset = -1;
  endOffset = -1;

  setStart(_node: unknown, offset: number): void {
    this.startOffset = offset;
  }

  setEnd(_node: unknown, offset: number): void {
    this.endOffset = offset;
  }
}

const installFakeDom = (root: HTMLElement, text: string) => {
  const textNode = new FakeTextNode(text);
  let didVisitTextNode = false;
  const createRange = vi.fn(() => new FakeRange() as unknown as Range);

  vi.stubGlobal('Text', FakeTextNode);
  vi.stubGlobal('NodeFilter', { SHOW_ELEMENT: 1, SHOW_TEXT: 4 });
  vi.stubGlobal('document', {
    createTreeWalker: (receivedRoot: HTMLElement) => {
      expect(receivedRoot).toBe(root);
      return {
        nextNode: () => {
          if (didVisitTextNode) return null;
          didVisitTextNode = true;
          return textNode;
        },
      };
    },
    createRange,
  });

  return { createRange };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('conversation search DOM highlights', () => {
  test('creates ranges only for occurrences used by rendered message matches', () => {
    const messageElement = {
      dataset: { coworkSearchMessageId: 'message-1' },
      contains: () => true,
    } as unknown as HTMLElement;
    const container = {
      querySelectorAll: () => [messageElement],
    } as unknown as HTMLElement;
    const { createRange } = installFakeDom(
      messageElement,
      'x'.repeat(CONVERSATION_SEARCH_MATCH_LIMIT * 20),
    );

    const result = applyConversationSearchHighlights(
      container,
      'x',
      [
        {
          key: 'message-1:1',
          messageId: 'message-1',
          messageType: 'assistant',
          absoluteMessageIndex: 0,
          occurrenceIndex: 1,
        },
        {
          key: `message-1:${CONVERSATION_SEARCH_MATCH_LIMIT - 1}`,
          messageId: 'message-1',
          messageType: 'assistant',
          absoluteMessageIndex: 0,
          occurrenceIndex: CONVERSATION_SEARCH_MATCH_LIMIT - 1,
        },
      ],
      `message-1:${CONVERSATION_SEARCH_MATCH_LIMIT - 1}`,
    );

    expect(createRange).toHaveBeenCalledTimes(2);
    expect(result.activeElement).toBe(messageElement);
    expect(result.activeRange).not.toBeNull();
  });

  test('never scans or creates ranges beyond the global result limit', () => {
    const root = {
      contains: () => true,
    } as unknown as HTMLElement;
    const { createRange } = installFakeDom(
      root,
      'x'.repeat(CONVERSATION_SEARCH_MATCH_LIMIT + 100),
    );

    const ranges = getConversationSearchRanges(root, 'x', {
      requiredOccurrenceIndexes: new Set([
        0,
        CONVERSATION_SEARCH_MATCH_LIMIT - 1,
        CONVERSATION_SEARCH_MATCH_LIMIT,
      ]),
    });

    expect(createRange).toHaveBeenCalledTimes(2);
    expect(ranges[0]).toBeDefined();
    expect(ranges[CONVERSATION_SEARCH_MATCH_LIMIT - 1]).toBeDefined();
    expect(ranges[CONVERSATION_SEARCH_MATCH_LIMIT]).toBeUndefined();
  });

  test('counts virtualized code text without creating hidden ranges or shifting later matches', () => {
    class FakeHTMLElement {
      dataset: Record<string, string>;

      constructor(dataset: Record<string, string> = {}) {
        this.dataset = dataset;
      }
    }
    const marker = new FakeHTMLElement({ coworkSearchVirtualText: 'true' });
    const afterText = new FakeTextNode('after needle');
    const nodes = [marker, afterText];
    let nodeIndex = 0;
    const createRange = vi.fn(() => new FakeRange() as unknown as Range);
    const root = { contains: () => true } as unknown as HTMLElement;

    vi.stubGlobal('HTMLElement', FakeHTMLElement);
    vi.stubGlobal('Text', FakeTextNode);
    vi.stubGlobal('NodeFilter', { SHOW_ELEMENT: 1, SHOW_TEXT: 4 });
    vi.stubGlobal('document', {
      createTreeWalker: () => ({
        nextNode: () => nodes[nodeIndex++] ?? null,
      }),
      createRange,
    });
    const unregister = registerVirtualSearchText(
      marker as unknown as HTMLElement,
      'needle in virtual code; needle again; ',
    );

    try {
      const ranges = getConversationSearchRanges(root, 'needle', {
        requiredOccurrenceIndexes: new Set([0, 1, 2]),
      });

      expect(createRange).toHaveBeenCalledTimes(1);
      expect(ranges[0]).toBeUndefined();
      expect(ranges[1]).toBeUndefined();
      expect(ranges[2]).toBeDefined();
    } finally {
      unregister();
    }
  });
});
