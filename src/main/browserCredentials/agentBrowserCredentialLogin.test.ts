import { ipcMain } from 'electron';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { BrowserCredentialTimeout, BrowserCredentialUseMode } from '../../shared/browserCredentials/constants';
import { McpBridgeServer } from '../libs/mcpBridgeServer';
import { AgentBrowserCredentialLogin, type AgentBrowserCredentialLoginDeps } from './agentBrowserCredentialLogin';
import { BrowserCredentialApprovalService } from './browserCredentialApprovalService';
import { BrowserCredentialGuestCommandType, BrowserCredentialGuestResultKind } from './credentialLoginProtocol';

const { webContents, onViewChanged } = vi.hoisted(() => ({
  webContents: {
    loadURL: vi.fn(), close: vi.fn(), isDestroyed: vi.fn(() => false),
    id: 1, isLoading: vi.fn(() => false), getURL: vi.fn(() => 'https://example.com/login'),
    on: vi.fn(), setWindowOpenHandler: vi.fn(), send: vi.fn(),
  },
  onViewChanged: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  WebContentsView: class {
    webContents = webContents;
    setBackgroundColor() {}
  },
}));

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  webContents.loadURL.mockImplementation(() => new Promise(() => {}));
  webContents.send.mockReset();
  webContents.close.mockReset();
  webContents.isDestroyed.mockReturnValue(false);
  onViewChanged.mockReset();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function fixture() {
  const bridge = new McpBridgeServer('test-secret');
  let requestId = '';
  bridge.onAskUser(request => { requestId = request.requestId; });
  const credential = { id: 'one', origin: 'https://example.com', username: 'alice', createdAt: 1, updatedAt: 1 };
  const getSecret = vi.fn(() => ({ summary: credential, password: 'private-test-password' }));
  const approvalService = new BrowserCredentialApprovalService({
    askUser: (questions, timeout, options) => bridge.askUserInternal(questions, timeout, options), translate: key => key,
  });
  const markUsed = vi.fn();
  const flushStore = vi.fn(async () => {});
  const login = new AgentBrowserCredentialLogin({
    browserSession: { flushStorageData: vi.fn(), cookies: { flushStore } },
    credentialService: { getAvailability: () => ({ available: true }), list: () => [credential], getSecret, markUsed },
    approvalService, getUseMode: () => BrowserCredentialUseMode.AlwaysAsk,
    resolveSessionKey: () => 'agent:main:lobsterai:session-a', onViewChanged, onStateChanged: vi.fn(),
    preloadPath: '/unused/preload.js',
  } as unknown as AgentBrowserCredentialLoginDeps);
  return { bridge, login, getSecret, markUsed, flushStore, requestId: () => requestId };
}
const request = { url: 'https://example.com/login', sessionId: 'session-a' };
const allow = { behavior: 'allow' as const, answers: { browserCredentialApprovalQuestion: 'browserCredentialApprovalAllow' } };

test('approval after 90 seconds is accepted; a hung login is bounded independently and closes its view', async () => {
  const f = fixture();
  const response = f.login.login(request);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(f.getSecret).not.toHaveBeenCalled();
  expect(f.bridge.resolveAskUser(f.requestId(), allow)).toBe(true);
  await vi.advanceTimersByTimeAsync(BrowserCredentialTimeout.Execution - 1);
  expect(f.login.isActive).toBe(true);
  expect(f.getSecret).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await expect(response).resolves.toMatchObject({ outcome: 'failed', message: 'Saved-credential sign-in execution timed out.' });
  expect(webContents.close).toHaveBeenCalledOnce();
  expect(webContents.send).not.toHaveBeenCalled();
  expect(f.login.isActive).toBe(false);
});

test.each(['timeout', 'cancel', 'dispose'] as const)('%s during approval never reads or fills a password', async action => {
  const f = fixture(); const controller = new AbortController();
  const response = f.login.login({ ...request, signal: controller.signal });
  if (action === 'timeout') await vi.advanceTimersByTimeAsync(BrowserCredentialTimeout.Approval);
  else if (action === 'cancel') controller.abort();
  else await f.login.dispose();
  await response;
  expect(f.bridge.resolveAskUser(f.requestId(), allow)).toBe(false);
  expect(f.getSecret).not.toHaveBeenCalled();
  expect(webContents.loadURL).not.toHaveBeenCalled();
  expect(f.login.isActive).toBe(false);
});

test('cancellation during navigation blocks late load completion from submitting credentials', async () => {
  let loaded!: () => void;
  webContents.loadURL.mockImplementation(() => new Promise<void>(resolve => { loaded = resolve; }));
  const f = fixture(); const controller = new AbortController();
  const response = f.login.login({ ...request, signal: controller.signal });
  f.bridge.resolveAskUser(f.requestId(), allow);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await expect(response).resolves.toMatchObject({ outcome: 'failed' });
  loaded();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(webContents.send).not.toHaveBeenCalled();
  expect(webContents.close).toHaveBeenCalledOnce();
});


test.each(['password', 'username-first', 'mfa', 'captcha'] as const)('existing %s login flow completes and cleans up listeners', async flow => {
  const handlers = new Set<(...args: unknown[]) => void>();
  vi.mocked(ipcMain.on).mockImplementation((_channel, handler) => { handlers.add(handler); return ipcMain; });
  vi.mocked(ipcMain.removeListener).mockImplementation((_channel, handler) => { handlers.delete(handler); return ipcMain; });
  webContents.loadURL.mockResolvedValue(undefined);
  let inspections = 0; let submissions = 0;
  webContents.send.mockImplementation((_channel, command) => {
    let kind: string = BrowserCredentialGuestResultKind.NoLoginForm;
    if (command.type === BrowserCredentialGuestCommandType.Inspect) {
      inspections += 1;
      if (flow === 'mfa') kind = BrowserCredentialGuestResultKind.MfaForm;
      else if (flow === 'captcha') kind = BrowserCredentialGuestResultKind.Captcha;
      else if (inspections === 1) kind = flow === 'username-first' ? BrowserCredentialGuestResultKind.UsernameForm : BrowserCredentialGuestResultKind.PasswordForm;
      else if (flow === 'username-first' && inspections === 2) kind = BrowserCredentialGuestResultKind.PasswordForm;
    } else if (command.type === BrowserCredentialGuestCommandType.FillAndSubmit) {
      submissions += 1;
      kind = flow === 'username-first' && submissions === 1 ? BrowserCredentialGuestResultKind.SubmittedUsername : BrowserCredentialGuestResultKind.SubmittedPassword;
    }
    for (const handler of handlers) handler({ sender: { id: webContents.id } }, { requestId: command.requestId, kind, url: 'https://example.com/login' });
  });
  const f = fixture(); const response = f.login.login(request);
  f.bridge.resolveAskUser(f.requestId(), allow);
  await vi.advanceTimersByTimeAsync(1_000);
  const result = await response;
  expect(result.outcome).toBe(flow === 'mfa' ? 'needs-mfa' : flow === 'captcha' ? 'needs-captcha' : 'authenticated');
  expect(submissions).toBe(flow === 'username-first' ? 2 : flow === 'password' ? 1 : 0);
  expect(JSON.stringify(result)).not.toContain('private-test-password');
  expect(f.flushStore).toHaveBeenCalledTimes(flow === 'captcha' ? 0 : 1);
  expect(webContents.close).toHaveBeenCalledOnce();
  expect(handlers.size).toBe(0);
  expect(f.login.isActive).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test('cancelling a pending guest command removes the IPC listener without filling credentials', async () => {
  const handlers = new Set<(...args: unknown[]) => void>();
  vi.mocked(ipcMain.on).mockImplementation((_channel, handler) => { handlers.add(handler); return ipcMain; });
  vi.mocked(ipcMain.removeListener).mockImplementation((_channel, handler) => { handlers.delete(handler); return ipcMain; });
  webContents.loadURL.mockResolvedValue(undefined);
  const f = fixture(); const controller = new AbortController();
  const response = f.login.login({ ...request, signal: controller.signal });
  f.bridge.resolveAskUser(f.requestId(), allow);
  await vi.advanceTimersByTimeAsync(0);
  expect(handlers.size).toBe(1);
  controller.abort();
  await expect(response).resolves.toMatchObject({ outcome: 'failed' });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(handlers.size).toBe(0);
  expect(webContents.send.mock.calls.some(([, command]) => command.type === BrowserCredentialGuestCommandType.FillAndSubmit)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});


test.each(['detach', 'already-destroyed', 'close-error'] as const)('cleanup tolerates %s and releases the login lock and listeners', async failure => {
  const f = fixture();
  webContents.loadURL.mockRejectedValue(new Error('private-navigation-detail'));
  const controller = new AbortController();
  const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
  if (failure === 'detach') onViewChanged.mockImplementation(view => { if (!view) throw new Error('detached'); });
  if (failure === 'already-destroyed') webContents.isDestroyed.mockReturnValue(true);
  if (failure === 'close-error') webContents.close.mockImplementation(() => { throw new Error('WebContents destroyed'); });
  const response = f.login.login({ ...request, signal: controller.signal });
  f.bridge.resolveAskUser(f.requestId(), allow);
  await vi.advanceTimersByTimeAsync(BrowserCredentialTimeout.Cleanup);
  await expect(response).resolves.toMatchObject({ outcome: 'failed' });
  expect(f.login.isActive).toBe(false);
  expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  if (failure === 'already-destroyed') expect(webContents.close).not.toHaveBeenCalled();
  else expect(webContents.close).toHaveBeenCalledOnce();
  const next = f.login.login(request);
  expect(f.login.isActive).toBe(true);
  f.bridge.resolveAskUser(f.requestId(), { behavior: 'deny' });
  await expect(next).resolves.toMatchObject({ outcome: 'denied' });
});

test('repeated cancellations release timers and request listeners without logging credentials', async () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const f = fixture();
    for (let index = 0; index < 100; index += 1) {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const response = f.login.login({ ...request, signal: controller.signal });
      controller.abort();
      await response;
      expect(f.login.isActive).toBe(false);
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.bridge.resolveAskUser(f.requestId(), allow)).toBe(false);
    }
    const logs = JSON.stringify([...debug.mock.calls, ...warn.mock.calls]);
    expect(logs).toContain('session-a');
    for (const value of ['private-test-password', 'alice', 'https://example.com']) expect(logs).not.toContain(value);
    expect(f.getSecret).not.toHaveBeenCalled();
  } finally { debug.mockRestore(); warn.mockRestore(); }
});
