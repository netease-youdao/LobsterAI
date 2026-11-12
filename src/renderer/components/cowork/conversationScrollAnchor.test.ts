import { describe, expect, test } from 'vitest';

import {
  captureConversationScrollAnchor,
  ConversationScrollAnchorAttribute,
  restoreConversationScrollAnchor,
} from './conversationScrollAnchor';

function makeViewport() {
  const blocks: Array<{ id: string; top: number; height: number; attribute: string; element: HTMLElement }> = [];
  const container = {
    scrollTop: 60,
    scrollHeight: 3000,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 50, bottom: 650, height: 600 }),
    querySelectorAll: (selector: string) => blocks
      .filter(block => selector === `[${block.attribute}]`)
      .map(block => block.element),
  } as unknown as HTMLElement & { scrollHeight: number };
  const add = (id: string, top: number, height: number, attribute: string = ConversationScrollAnchorAttribute.Message) => {
    const block = { id, top, height, attribute, element: {} as HTMLElement };
    block.element = {
      getAttribute: (name: string) => name === attribute ? id : null,
      getBoundingClientRect: () => ({
        top: 50 + block.top - container.scrollTop,
        bottom: 50 + block.top + block.height - container.scrollTop,
        height: block.height,
      }),
    } as HTMLElement;
    blocks.push(block);
    return block;
  };
  return { container, blocks, add };
}

describe('conversation scroll anchor', () => {
  test('keeps the visible message at the same position after an unanchored prepend', () => {
    const { container, add } = makeViewport();
    const message = add('reading', 0, 400);
    const anchor = captureConversationScrollAnchor(container)!;
    message.top += 1000;
    container.scrollHeight += 1000;
    expect(restoreConversationScrollAnchor(container, anchor)).toBe(true);
    expect(container.scrollTop).toBe(1060);
    expect(message.element.getBoundingClientRect().top).toBe(-10);
  });

  test('does not double-compensate when Chromium has already preserved the message', () => {
    const { container, add } = makeViewport();
    const message = add('reading', 0, 400);
    const anchor = captureConversationScrollAnchor(container)!;
    message.top += 1000;
    container.scrollHeight += 1000;
    container.scrollTop += 1000;
    restoreConversationScrollAnchor(container, anchor);
    expect(container.scrollTop).toBe(1060);
  });

  test('does not move the reader when only the content below them grows', () => {
    const { container, add } = makeViewport();
    add('reading', 0, 400);
    const anchor = captureConversationScrollAnchor(container)!;
    container.scrollHeight += 2000;
    restoreConversationScrollAnchor(container, anchor);
    expect(container.scrollTop).toBe(60);
  });

  test('restores a reader at zero, where native scroll anchoring is suppressed', () => {
    const { container, add } = makeViewport();
    container.scrollTop = 0;
    const message = add('reading', 0, 400);
    const anchor = captureConversationScrollAnchor(container)!;
    message.top += 800;
    container.scrollHeight += 800;
    restoreConversationScrollAnchor(container, anchor);
    expect(container.scrollTop).toBe(800);
  });

  test('uses a surviving visible neighbor if the first message disappears', () => {
    const { container, blocks, add } = makeViewport();
    add('removed', 0, 200);
    const remaining = add('remaining', 200, 200);
    const anchor = captureConversationScrollAnchor(container)!;
    blocks.shift();
    remaining.top += 500;
    restoreConversationScrollAnchor(container, anchor);
    expect(container.scrollTop).toBe(560);
  });

  test('anchors the bottom of a tool-only partial turn when its beginning is filled in', () => {
    const { container, add } = makeViewport();
    const turn = add('last-tool', 0, 900, ConversationScrollAnchorAttribute.Turn);
    const anchor = captureConversationScrollAnchor(container)!;
    // Prepending the user message changes the turn key and grows it from above.
    turn.height += 1000;
    container.scrollHeight += 1000;
    restoreConversationScrollAnchor(container, anchor);
    expect(container.scrollTop).toBe(1060);
  });

  test('prefers a visible real message over a turn wrapper', () => {
    const { container, add } = makeViewport();
    add('turn-last-message', 0, 2000, ConversationScrollAnchorAttribute.Turn);
    add('reading', 20, 400);
    expect(captureConversationScrollAnchor(container)?.candidates[0].messageId).toBe('reading');
  });

  test('does not use a turn bottom as an anchor for arbitrary streaming height changes', () => {
    const { container, add } = makeViewport();
    add('tool-turn', 0, 900, ConversationScrollAnchorAttribute.Turn);
    expect(captureConversationScrollAnchor(container, { includeTurnFallback: false })).toBeNull();
  });

  test('ignores hidden and offscreen messages and does not invent an anchor for placeholders', () => {
    const { container, add } = makeViewport();
    add('above', 0, 40);
    add('hidden', 100, 0);
    add('below', 800, 100);
    expect(captureConversationScrollAnchor(container)).toBeNull();
  });

  test('clamps restoration when the content shrinks past the beginning', () => {
    const { container, add } = makeViewport();
    const message = add('reading', 100, 400);
    const anchor = captureConversationScrollAnchor(container)!;
    message.top = 0;
    restoreConversationScrollAnchor(container, anchor);
    expect(container.scrollTop).toBe(0);
  });
});
