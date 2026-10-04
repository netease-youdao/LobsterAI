// @vitest-environment jsdom
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useOlderMessagesPagination } from './useOlderMessagesPagination';

let host: HTMLDivElement;
let root: Root;
let container: HTMLDivElement;
let containerRef: { current: HTMLDivElement };
let pagination: ReturnType<typeof useOlderMessagesPagination>;
let height: number;
let loadPage: ReturnType<typeof vi.fn<(sessionId: string) => Promise<boolean>>>;
type Props = { sessionId?: string; offset?: number; count?: number; automatic?: boolean };

function View({ sessionId = 'a', offset = 100, count = 30, automatic = false }: Props) {
  pagination = useOlderMessagesPagination({
    sessionId,
    offset,
    messageCount: count,
    containerRef,
    loadPage,
  });
  const { isLoading, loadOlderMessages } = pagination;
  useEffect(() => {
    if (automatic && !isLoading) void loadOlderMessages(true);
  }, [automatic, isLoading, loadOlderMessages]);
  return React.createElement('output', null, isLoading ? 'loading' : 'ready');
}

function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function render(props: Props = {}) {
  act(() => root.render(React.createElement(View, props)));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  container = document.createElement('div');
  containerRef = { current: container };
  height = 400;
  Object.defineProperty(container, 'scrollHeight', { get: () => height });
  container.scrollTop = 25;
  loadPage = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([false, true])(
  'clears loading when a page resolves %s without changing message count',
  async result => {
    const page = deferred();
    loadPage.mockReturnValue(page.promise);
    render();
    act(() => {
      void pagination.loadOlderMessages();
    });
    expect(host.textContent).toBe('loading');
    await act(async () => page.resolve(result));
    expect(host.textContent).toBe('ready');
    expect(pagination.isLoadingRef.current).toBe(false);
    expect(container.scrollTop).toBe(25);
  },
);

test('clears rejected requests and allows a manual retry', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const page = deferred();
  loadPage.mockReturnValueOnce(page.promise).mockResolvedValue(false);
  render();
  act(() => {
    void pagination.loadOlderMessages();
  });
  await act(async () => page.reject(new Error('IPC failed')));
  expect(host.textContent).toBe('ready');
  await act(async () => {
    await pagination.loadOlderMessages();
  });
  expect(loadPage).toHaveBeenCalledTimes(2);
  expect(pagination.isLoadingRef.current).toBe(false);
});

test('does not loop automatic pagination on an immediately resolved empty page', async () => {
  loadPage.mockResolvedValue(false);
  await act(async () => root.render(React.createElement(View, { automatic: true })));
  expect(host.textContent).toBe('ready');
  expect(pagination.isLoadingRef.current).toBe(false);
  expect(loadPage).toHaveBeenCalledTimes(1);
});

test('waits for request settlement before auto-loading the next page after a store update', async () => {
  const first = deferred();
  const second = deferred();
  loadPage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  render({ automatic: true });
  expect(loadPage).toHaveBeenCalledTimes(1);
  height = 700;
  // Redux can render the newly prepended messages before the service clears its in-flight promise.
  render({ automatic: true, offset: 50, count: 80 });
  expect(host.textContent).toBe('loading');
  expect(loadPage).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve(true));
  expect(container.scrollTop).toBe(325);
  expect(loadPage).toHaveBeenCalledTimes(2);
  render({ automatic: true, offset: 0, count: 130 });
  height = 900;
  await act(async () => second.resolve(true));
  expect(host.textContent).toBe('ready');
  expect(container.scrollTop).toBe(525);
  expect(loadPage).toHaveBeenCalledTimes(2);
});

test('live messages do not end a pending page or move its reading anchor', async () => {
  const page = deferred();
  loadPage.mockReturnValue(page.promise);
  render();
  act(() => {
    void pagination.loadOlderMessages();
  });
  height = 600;
  render({ count: 31 });
  expect(host.textContent).toBe('loading');
  await act(async () => page.resolve(false));
  expect(host.textContent).toBe('ready');
  expect(container.scrollTop).toBe(25);
});

test('a discarded page does not move the anchor after navigation replaces the message window', async () => {
  const page = deferred();
  loadPage.mockReturnValue(page.promise);
  render();
  act(() => {
    void pagination.loadOlderMessages();
  });
  height = 900;
  render({ offset: 20, count: 80 });
  await act(async () => page.resolve(false));
  expect(host.textContent).toBe('ready');
  expect(container.scrollTop).toBe(25);
});

test('invalidates old completions after switching sessions', async () => {
  const first = deferred();
  const second = deferred();
  loadPage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  render();
  act(() => {
    void pagination.loadOlderMessages();
  });
  render({ sessionId: 'b' });
  expect(host.textContent).toBe('ready');
  act(() => {
    void pagination.loadOlderMessages();
  });
  await act(async () => first.resolve(true));
  expect(host.textContent).toBe('loading');
  expect(pagination.isLoadingRef.current).toBe(true);
  await act(async () => second.resolve(false));
  expect(host.textContent).toBe('ready');
  expect(container.scrollTop).toBe(25);
});
