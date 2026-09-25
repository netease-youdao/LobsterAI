// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useOpenClawProgressCard } from './useOpenClawProgressCard';
let root: Root, host: HTMLDivElement, listener: (event: { sessionId: string }) => void;
let state: ReturnType<typeof useOpenClawProgressCard>;
const card = (revision: number) => ({ sessionKey: 'native', revision, updatedAt: 1, markdown: `Revision ${revision}` });
const get = vi.fn(), dismiss = vi.fn(), refresh = vi.fn(), off = vi.fn();
function Probe({ id }: { id: string }) { state = useOpenClawProgressCard(id); return null; }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  get.mockReset(); dismiss.mockReset(); refresh.mockReset(); off.mockReset();
  Object.defineProperty(window, 'electron', { configurable: true, value: { cowork: { getProgressCard: get, dismissProgressCard: dismiss, refreshProgressCard: refresh, onProgressCardChanged: (fn: typeof listener) => { listener = fn; return off; } } } });
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const render = (id: string) => act(async () => root.render(React.createElement(Probe, { id })));
test('loads saved state; ignores other sessions; updates, preserves on error, retries and clears', async () => {
  get.mockResolvedValue({ success: true, card: card(1) }); await render('one');
  expect(state.card?.revision).toBe(1);
  await act(async () => listener({ sessionId: 'other' })); expect(get).toHaveBeenCalledTimes(1);
  get.mockResolvedValue({ success: false }); await act(async () => listener({ sessionId: 'one' }));
  expect(state.card?.revision).toBe(1); expect(state.error).toBe(true);
  get.mockResolvedValue({ success: true, card: card(2) }); await act(async () => { await state.reload(); });
  expect(state.card?.revision).toBe(2); expect(state.error).toBe(false);
  get.mockResolvedValue({ success: true, card: null }); await act(async () => listener({ sessionId: 'one' }));
  expect(state.card).toBeNull();
});
test('late reads never replace a newer event result or leak into another session', async () => {
  let resolve!: (v: unknown) => void;
  get.mockImplementationOnce(() => new Promise(r => { resolve = r; })); await render('one');
  get.mockResolvedValue({ success: true, card: card(3) }); await act(async () => listener({ sessionId: 'one' }));
  await act(async () => resolve({ success: true, card: card(1) })); expect(state.card?.revision).toBe(3);
  get.mockImplementationOnce(() => new Promise(r => { resolve = r; })); await act(async () => listener({ sessionId: 'one' }));
  get.mockResolvedValue({ success: true, card: null }); await render('two');
  await act(async () => resolve({ success: true, card: card(4) })); expect(state.card).toBeNull(); expect(off).toHaveBeenCalled();
});
test('duplicate closes are locked and a conflict returns the newer saved card', async () => {
  get.mockResolvedValue({ success: true, card: card(1) }); await render('one');
  let resolve!: (v: unknown) => void;
  dismiss.mockImplementation(() => new Promise(r => { resolve = r; }));
  let done!: Promise<void>;
  await act(async () => { done = state.dismiss(); void state.dismiss(); });
  expect(dismiss).toHaveBeenCalledTimes(1);
  await act(async () => { resolve({ success: true, card: card(2) }); await done; });
  expect(state.card?.revision).toBe(2); expect(state.busy).toBe(false);
});

test('accepted refresh waits for a newer card and retains the old card on failure', async () => {
  get.mockResolvedValue({ success: true, card: card(1) }); await render('one');
  refresh.mockResolvedValue({ success: true, receipt: { runId: 'r', status: 'accepted', revision: 1 } });
  await act(async () => { await state.refresh(); });
  expect(state.refreshing).toBe(true); expect(state.card?.revision).toBe(1);
  get.mockResolvedValue({ success: true, card: card(2) });
  await act(async () => listener({ sessionId: 'one' }));
  expect(state.refreshing).toBe(false); expect(state.card?.revision).toBe(2);
  refresh.mockResolvedValue({ success: false });
  await act(async () => { await state.refresh(); });
  expect(state.refreshError).toBe(true); expect(state.card?.revision).toBe(2);
});
test('a card event before the refresh ACK completes the request without another send', async () => {
  get.mockResolvedValue({ success: true, card: card(1) }); await render('one');
  let resolve!: (v: unknown) => void;
  refresh.mockImplementation(() => new Promise(r => { resolve = r; }));
  let pending!: Promise<void>;
  await act(async () => { pending = state.refresh(); void state.refresh(); });
  get.mockResolvedValue({ success: true, card: card(2) });
  await act(async () => listener({ sessionId: 'one' }));
  await act(async () => { resolve({ success: true, receipt: { runId: 'r', status: 'accepted', revision: 1 } }); await pending; });
  expect(state.refreshing).toBe(false); expect(refresh).toHaveBeenCalledTimes(1);
});
test('late refresh ACK cannot affect a different session', async () => {
  get.mockResolvedValue({ success: true, card: card(1) }); await render('one');
  let resolve!: (v: unknown) => void;
  refresh.mockImplementation(() => new Promise(r => { resolve = r; }));
  let pending!: Promise<void>;
  await act(async () => { pending = state.refresh(); });
  get.mockResolvedValue({ success: true, card: null }); await render('two');
  await act(async () => { resolve({ success: true, receipt: { runId: 'r', status: 'accepted', revision: 1 } }); await pending; });
  expect(state.refreshing).toBe(false); expect(state.card).toBeNull();
});

test('lost ACK retry uses the same key, terminal failure permits a new key', async () => {
  get.mockResolvedValue({ success: true, card: card(1) }); await render('one');
  refresh.mockRejectedValueOnce(new Error('connection closed'));
  await act(async () => { await state.refresh(); });
  const key = refresh.mock.calls[0][1];
  refresh.mockResolvedValueOnce({ success: false, terminal: true });
  await act(async () => { await state.refresh(); });
  expect(refresh.mock.calls[1][1]).toBe(key);
  refresh.mockResolvedValueOnce({ success: false });
  await act(async () => { await state.refresh(); });
  expect(refresh.mock.calls[2][1]).not.toBe(key);
});
test('refresh timeout retains the old card and ignores a late ACK', async () => {
  vi.useFakeTimers();
  try {
    get.mockResolvedValue({ success: true, card: card(1) }); await render('one');
    let resolve!: (v: unknown) => void;
    refresh.mockImplementation(() => new Promise(r => { resolve = r; }));
    let pending!: Promise<void>;
    await act(async () => { pending = state.refresh(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(state.refreshing).toBe(false); expect(state.refreshError).toBe(true);
    expect(state.card?.revision).toBe(1);
    await act(async () => { resolve({ success: true, receipt: { runId: 'r', status: 'accepted', revision: 1 } }); await pending; });
    expect(state.refreshing).toBe(false); expect(state.refreshError).toBe(true);
  } finally { vi.useRealTimers(); }
});
test('a native session segment change invalidates the pending refresh', async () => {
  get.mockResolvedValue({ success: true, card: card(1) }); await render('one');
  let resolve!: (v: unknown) => void;
  refresh.mockImplementation(() => new Promise(r => { resolve = r; }));
  let pending!: Promise<void>;
  await act(async () => { pending = state.refresh(); });
  get.mockResolvedValue({ success: true, card: { ...card(1), sessionKey: 'new-native' } });
  await act(async () => listener({ sessionId: 'one' }));
  await act(async () => { resolve({ success: true, receipt: { runId: 'r', status: 'accepted', revision: 1 } }); await pending; });
  expect(state.refreshing).toBe(false); expect(state.card?.sessionKey).toBe('new-native');
});

test('accepted refresh with no new card allows a fresh intent after timeout', async () => {
  vi.useFakeTimers();
  try {
    get.mockResolvedValue({ success: true, card: card(1) }); await render('one');
    refresh.mockResolvedValue({ success: true, receipt: { runId: 'r', status: 'accepted', revision: 1 } });
    await act(async () => { await state.refresh(); });
    const firstKey = refresh.mock.calls[0][1];
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(state.refreshError).toBe(true);
    await act(async () => { await state.refresh(); });
    expect(refresh.mock.calls[1][1]).not.toBe(firstKey);
  } finally { vi.useRealTimers(); }
});
