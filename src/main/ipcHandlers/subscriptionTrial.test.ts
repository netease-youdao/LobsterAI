import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';

import { SubscriptionTrialIpc } from '../../shared/subscriptionTrial/constants';
import { registerSubscriptionTrialIpcHandlers } from './subscriptionTrial';

type Handler = (event: IpcMainInvokeEvent) => Promise<unknown>;
const response = (code: number, data: unknown = null, status = 200) => new Response(JSON.stringify({ code, data }), { status });
function harness(authenticated = false) {
  const handlers = new Map<string, Handler>();
  const mainFrame = {};
  const webContents = { mainFrame };
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const fetchPublic = vi.fn<() => Promise<Response>>();
  const fetchWithAuth = vi.fn<() => Promise<Response>>();
  registerSubscriptionTrialIpcHandlers({
    ipcMain: { handle: (key: string, value: Handler) => handlers.set(key, value) } as unknown as IpcMain,
    getMainWindow: () => ({ isDestroyed: () => false, webContents }) as unknown as BrowserWindow,
    getServerBaseUrl: () => 'https://server.example',
    getClientVersion: () => 'test', platform: 'test', hasAuthTokens: () => authenticated,
    fetchPublic, fetchWithAuth,
  });
  return { fetchPublic, fetchWithAuth, invoke: (key: string) => handlers.get(key)!(event) };
}
afterEach(() => vi.restoreAllMocks());

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
