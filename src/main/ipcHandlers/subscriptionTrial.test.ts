import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';

import { SubscriptionTrialIpc } from '../../shared/subscriptionTrial/constants';
import { registerSubscriptionTrialIpcHandlers, SUBSCRIPTION_TRIAL_REQUEST_TIMEOUT_MS } from './subscriptionTrial';

type Handler = (event: IpcMainInvokeEvent) => Promise<unknown>;
const response = (code: number, data: unknown = null, status = 200) => new Response(JSON.stringify({ code, data }), { status });
function harness(authenticated = false) {
  const handlers = new Map<string, Handler>();
  const mainFrame = {};
  const webContents = { mainFrame };
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const fetchPublic = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const fetchWithAuth = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  registerSubscriptionTrialIpcHandlers({
    ipcMain: { handle: (key: string, value: Handler) => handlers.set(key, value) } as unknown as IpcMain,
    getMainWindow: () => ({ isDestroyed: () => false, webContents }) as unknown as BrowserWindow,
    getServerBaseUrl: () => 'https://server.example',
    getClientVersion: () => 'test', platform: 'test', hasAuthTokens: () => authenticated,
    fetchPublic, fetchWithAuth,
  });
  return { fetchPublic, fetchWithAuth, invoke: (key: string) => handlers.get(key)!(event) };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('anonymous activity lookup uses the public API, without requiring login', async () => {
  const h = harness();
  const state = { active: true, visible: true, eligible: false, reason: 'login_required' };
  h.fetchPublic.mockResolvedValue(response(0, state));
  expect(await h.invoke(SubscriptionTrialIpc.Status)).toEqual(state);
  expect(h.fetchWithAuth).not.toHaveBeenCalled();
});

test('authenticated activity lookup uses account credentials without claiming an exposure', async () => {
  const h = harness(true);
  h.fetchWithAuth.mockResolvedValue(response(0, { active: true, visible: true }));
  await h.invoke(SubscriptionTrialIpc.Status);
  expect(h.fetchWithAuth).toHaveBeenCalledWith('https://server.example/api/subscription-trial', expect.objectContaining({ method: 'GET' }));
  expect(h.fetchPublic).not.toHaveBeenCalled();
});

test('an unavailable endpoint hides the offer and reports a deduplicated diagnostic', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const h = harness();
  h.fetchPublic.mockImplementation(async () => response(40100, null, 401));
  expect(await h.invoke(SubscriptionTrialIpc.Status)).toBeNull();
  expect(await h.invoke(SubscriptionTrialIpc.Status)).toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toContain('authenticated=false, http=401, code=40100');
});

test('network failures are hidden with a safe diagnostic and never downgrade authenticated requests', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const h = harness(true);
  h.fetchWithAuth.mockRejectedValue(new TypeError('private transport detail'));
  expect(await h.invoke(SubscriptionTrialIpc.Status)).toBeNull();
  expect(h.fetchPublic).not.toHaveBeenCalled();
  expect(warn.mock.calls[0]?.[0]).toContain('failure=TypeError');
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private transport detail');
});

test.each([false, true])('times out a stalled trial lookup and aborts its request (authenticated=%s)', async authenticated => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const h = harness(authenticated);
  const fetcher = authenticated ? h.fetchWithAuth : h.fetchPublic;
  // Auth refresh or a transport may remain pending even after cancellation.
  fetcher.mockImplementation(() => new Promise<Response>(() => undefined));
  const pending = h.invoke(SubscriptionTrialIpc.Status);
  const signal = fetcher.mock.calls[0]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);

  await vi.advanceTimersByTimeAsync(SUBSCRIPTION_TRIAL_REQUEST_TIMEOUT_MS);

  expect(await pending).toBeNull();
  expect(signal?.aborted).toBe(true);
  expect(warn.mock.calls[0]?.[0]).toContain('failure=TimeoutError');
  if (authenticated) expect(h.fetchPublic).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('the trial deadline also covers a stalled response body', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const h = harness();
  const stalledResponse = new Response();
  vi.spyOn(stalledResponse, 'json').mockImplementation(() => new Promise(() => undefined));
  h.fetchPublic.mockResolvedValue(stalledResponse);
  const pending = h.invoke(SubscriptionTrialIpc.Status);

  await vi.advanceTimersByTimeAsync(SUBSCRIPTION_TRIAL_REQUEST_TIMEOUT_MS);

  expect(await pending).toBeNull();
  expect(h.fetchPublic.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

test('a completed trial lookup clears its deadline without aborting the response', async () => {
  vi.useFakeTimers();
  const h = harness();
  const state = { clientMenuEntryVisible: true, eligible: true };
  h.fetchPublic.mockResolvedValue(response(0, state));

  expect(await h.invoke(SubscriptionTrialIpc.Status)).toEqual(state);
  expect(vi.getTimerCount()).toBe(0);
  expect(h.fetchPublic.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
});
