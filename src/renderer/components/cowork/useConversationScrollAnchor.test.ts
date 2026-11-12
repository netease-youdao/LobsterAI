import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ConversationScrollAnchorAttribute } from './conversationScrollAnchor';

// The project uses a Node test environment. Run hook commits deterministically
// here; the browser regression additionally exercises real layout/observers.
const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  let effects: Array<() => void> = [];
  let dirty = false;
  return {
    reset: () => { cursor = 0; slots = []; effects = []; dirty = false; },
    begin: () => { cursor = 0; dirty = false; },
    commit: () => {
      const pending = effects;
      effects = [];
      pending.forEach(effect => effect());
      return dirty;
    },
    useRef: <T,>(initial: T) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useState: <T,>(initial: T) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index] as T, (value: T) => {
        if (!Object.is(slots[index], value)) dirty = true;
        slots[index] = value;
      }] as const;
    },
    useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = cursor++;
      const previous = slots[index] as { deps: unknown[]; cleanup?: void | (() => void) } | undefined;
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      const next: { deps: unknown[]; cleanup?: void | (() => void) } = { deps };
      slots[index] = next;
      effects.push(() => {
        previous?.cleanup?.();
        next.cleanup = effect();
      });
    },
  };
});

vi.mock('react', () => ({
  useCallback: <T,>(callback: T) => callback,
  useRef: hooks.useRef,
  useState: hooks.useState,
  useLayoutEffect: hooks.useLayoutEffect,
}));

import { useConversationScrollAnchor } from './useConversationScrollAnchor';

const deferred = () => {
  let resolve!: (value: boolean) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<boolean>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

let resize: () => void;

function makeFixture() {
  let messageTop = 0;
  let canRestore = true;
  let beforePrepend!: (offset: number) => boolean;
  const page = deferred();
  const container = Object.assign(new EventTarget(), {
    scrollTop: 60,
    scrollHeight: 3000,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 50, bottom: 650, height: 600 }),
    querySelectorAll: (selector: string) => selector === `[${ConversationScrollAnchorAttribute.Message}]` ? [message] : [],
  }) as unknown as HTMLElement & { scrollHeight: number };
  const message = {
    getAttribute: () => 'reading',
    getBoundingClientRect: () => ({
      top: 50 + messageTop - container.scrollTop,
      bottom: 450 + messageTop - container.scrollTop,
      height: 400,
    }),
  };
  const loadMessages = vi.fn((capture: (offset: number) => boolean) => {
    beforePrepend = capture;
    return page.promise;
  });
  const options = {
    sessionId: 'first-session',
    messagesOffset: 50,
    scrollContainerRef: { current: container },
    canRestore: () => canRestore,
    loadMessages,
  };
  const render = () => {
    for (let i = 0; i < 20; i += 1) {
      hooks.begin();
      // This test intentionally drives a mocked React dispatcher.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const result = useConversationScrollAnchor(options);
      if (!hooks.commit()) return result;
    }
    throw new Error('Hook did not settle');
  };
  return {
    container, options, page, render, loadMessages,
    capture: () => beforePrepend(0),
    growAbove: (height: number) => { messageTop += height; container.scrollHeight += height; },
    lock: () => { canRestore = false; },
  };
}

beforeEach(() => {
  hooks.reset();
  resize = () => undefined;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() { /* controlled by the test */ }
    disconnect() { /* controlled by the test */ }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('conversation history scroll lifecycle', () => {
  test('captures the current reading position when the page arrives, not when its request starts', async () => {
    const fixture = makeFixture();
    const pending = fixture.render().loadOlderMessages();
    fixture.container.scrollTop = 220;
    fixture.capture();
    expect(fixture.render().anchorMessageId).toBe('reading');
    fixture.growAbove(1000);
    fixture.options.messagesOffset = 0;
    expect(fixture.render().isLoadingMoreMessagesRef.current).toBe(false);
    fixture.page.resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(fixture.container.scrollTop).toBe(1220);
  });

  test('does not consume a pending prepend when a streamed message increases the list height', async () => {
    const fixture = makeFixture();
    const pending = fixture.render().loadOlderMessages();
    fixture.container.scrollHeight += 200;
    expect(fixture.render().isLoadingMoreMessages).toBe(true);
    expect(fixture.container.scrollTop).toBe(60);
    fixture.capture();
    fixture.growAbove(1000);
    fixture.page.resolve(true);
    await pending;
    // The promise can resolve before React commits the new offset.
    expect(fixture.render().isLoadingMoreMessagesRef.current).toBe(true);
    fixture.options.messagesOffset = 0;
    expect(fixture.render().isLoadingMoreMessages).toBe(false);
    expect(fixture.container.scrollTop).toBe(1060);
  });

  test('releases the loading guard on an empty or rejected page', async () => {
    const fixture = makeFixture();
    const pending = fixture.render().loadOlderMessages();
    fixture.page.resolve(false);
    await expect(pending).resolves.toBe(false);
    expect(fixture.render().isLoadingMoreMessagesRef.current).toBe(false);
    expect(fixture.render().anchorMessageId).toBeNull();
  });

  test('releases the loading guard when the request throws', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fixture = makeFixture();
    const pending = fixture.render().loadOlderMessages();
    fixture.page.reject(new Error('Disconnected'));
    await expect(pending).resolves.toBe(false);
    expect(fixture.render().isLoadingMoreMessages).toBe(false);
    expect(warning).toHaveBeenCalledOnce();
  });

  test('does not let an old session request release the next session loading guard', async () => {
    const fixture = makeFixture();
    const oldRequest = fixture.render().loadOlderMessages();
    const nextPage = deferred();
    fixture.options.sessionId = 'second-session';
    fixture.render();
    expect(fixture.capture()).toBe(false);
    fixture.loadMessages.mockImplementationOnce(() => nextPage.promise);
    const nextRequest = fixture.render().loadOlderMessages();
    fixture.page.resolve(false);
    await oldRequest;
    expect(fixture.render().isLoadingMoreMessagesRef.current).toBe(true);
    nextPage.resolve(false);
    await nextRequest;
    expect(fixture.render().isLoadingMoreMessagesRef.current).toBe(false);
    expect(fixture.container.scrollTop).toBe(60);
  });

  test('stops automatic retries of the same failed page but permits an explicit retry', async () => {
    const fixture = makeFixture();
    fixture.loadMessages.mockResolvedValue(false);
    await fixture.render().loadOlderMessages({ automatic: true });
    await fixture.render().loadOlderMessages({ automatic: true });
    expect(fixture.loadMessages).toHaveBeenCalledOnce();
    await fixture.render().loadOlderMessages();
    expect(fixture.loadMessages).toHaveBeenCalledTimes(2);
  });

  test('yields to search, navigation, export and following when they own the viewport', async () => {
    const fixture = makeFixture();
    const pending = fixture.render().loadOlderMessages();
    fixture.capture();
    fixture.lock();
    fixture.growAbove(1000);
    fixture.options.messagesOffset = 0;
    fixture.render();
    fixture.page.resolve(true);
    await pending;
    expect(fixture.container.scrollTop).toBe(60);
  });

  test('cancels a captured restoration if the reader gestures before the page commits', async () => {
    const fixture = makeFixture();
    fixture.render().setContentElement({} as HTMLElement);
    const pending = fixture.render().loadOlderMessages();
    fixture.capture();
    fixture.container.dispatchEvent(new Event('wheel'));
    fixture.growAbove(1000);
    fixture.options.messagesOffset = 0;
    fixture.render();
    fixture.page.resolve(true);
    await pending;
    expect(fixture.container.scrollTop).toBe(60);
  });

  test('preserves the visible message through delayed layout changes without fighting a new gesture', () => {
    const fixture = makeFixture();
    fixture.render().setContentElement({} as HTMLElement);
    fixture.render();
    fixture.container.dispatchEvent(new Event('scroll'));
    fixture.growAbove(900);
    resize();
    expect(fixture.container.scrollTop).toBe(960);
    fixture.container.dispatchEvent(new Event('wheel'));
    fixture.growAbove(400);
    resize();
    expect(fixture.container.scrollTop).toBe(960);
  });
});
