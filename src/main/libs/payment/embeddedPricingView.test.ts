import { EventEmitter } from 'node:events';

import type { BrowserWindow, IpcMain, WebContentsViewConstructorOptions } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { EmbeddedPricingIpc, EmbeddedPricingState } from '../../../shared/payment/embeddedPricing';
import { AuthSessionManager } from '../authSessionManager';
import { PortalLoginOrigin } from '../embeddedLogin/loginUrlPolicy';
import { registerEmbeddedPricingIpcHandlers } from './embeddedPricingView';

const electron = vi.hoisted(() => ({ fromPartition: vi.fn(), createView: vi.fn() }));
vi.mock('electron', () => ({
  session: { fromPartition: electron.fromPartition },
  WebContentsView: class {
    constructor(options: WebContentsViewConstructorOptions) { return electron.createView(options); }
  },
}));

class FakeContents extends EventEmitter {
  destroyed = false;
  url = '';
  send = vi.fn();
  mainFrame = {};
  isDestroyed() { return this.destroyed; }
  getZoomFactor() { return 1; }
  getURL() { return this.url; }
  close() { this.destroyed = true; }
  focus() {}
  setWindowOpenHandler() {}
  insertCSS() { return Promise.resolve('styles'); }
  loadURL(url: string) { this.url = url; return Promise.resolve(); }
}

class FakeView {
  webContents = new FakeContents();
  setVisible = vi.fn();
  setBackgroundColor() {}
  setBounds() {}
}

class FakePartition extends EventEmitter {
  handler!: (request: Request) => Promise<Response>;
  protocol = {
    handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => { this.handler = handler; },
    unhandle: vi.fn(),
  };
  fetch = vi.fn(async () => new Response('asset'));
  clearStorageData = vi.fn(async () => undefined);
  clearCache = vi.fn(async () => undefined);
  setPermissionRequestHandler() {}
  setPermissionCheckHandler() {}
}

function setup() {
  let accountKey: string | null = 'user-a:personal:1';
  let tokens = { accessToken: 'access-a', refreshToken: 'refresh-a' };
  const parent = Object.assign(new EventEmitter(), {
    webContents: new FakeContents(),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1280, height: 800 }),
  });
  const partitions: FakePartition[] = [];
  const views: FakeView[] = [];
  electron.fromPartition.mockImplementation(() => {
    const partition = new FakePartition();
    partitions.push(partition);
    return partition;
  });
  electron.createView.mockImplementation(() => {
    const view = new FakeView();
    views.push(view);
    return view;
  });
  const network = vi.fn(async (_url: string, _options?: RequestInit) => new Response('{"code":0}'));
  const manager = new AuthSessionManager({
    getTokens: () => tokens,
    getSessionKey: () => accountKey,
    saveTokens: next => { tokens = next; },
    fetch: network,
    getRefreshUrl: () => `${PortalLoginOrigin.Production}/api/auth/refresh`,
    buildRefreshRequestBody: refreshToken => JSON.stringify({ refreshToken }),
    onTerminalFailure: () => undefined,
    onLifecycleEvent: () => undefined,
  });
  const resolveLoginUrl = vi.fn(async () => `${PortalLoginOrigin.Production}/portal#/login`);
  const controller = registerEmbeddedPricingIpcHandlers({
    ipcMain: { handle: vi.fn() } as unknown as IpcMain,
    getMainWindow: () => parent as unknown as BrowserWindow,
    resolveLoginUrl,
    getServerBaseUrl: () => PortalLoginOrigin.Production,
    getAccountKey: () => accountKey,
    fetchWithAuth: (url, options) => manager.fetchWithAuth(url, options),
    fetchPublic: network,
    openExternal: vi.fn(),
  });
  return {
    controller, parent, partitions, views, network, resolveLoginUrl,
    setAccount(key: string | null) { accountKey = key; },
    setAccessToken(token: string) { tokens = { ...tokens, accessToken: token }; },
  };
}

const request = (path = '/api/user/profile') => new Request(`${PortalLoginOrigin.Production}${path}`, {
  headers: { Cookie: 'browser-user-b', Authorization: 'Bearer page-token-b' },
});

beforeEach(() => { vi.clearAllMocks(); });

describe('embedded Portal account binding', () => {
  test('uses only the main-process JWT and never forwards webpage credentials or response Cookies', async () => {
    const context = setup();
    context.network.mockResolvedValueOnce(new Response('{"code":0}', { headers: { 'Set-Cookie': 'other-user' } }));
    await context.controller.open();
    const response = await context.partitions[0].handler(request());

    expect(response.status).toBe(200);
    expect(response.headers.has('set-cookie')).toBe(false);
    const options = context.network.mock.calls[0][1];
    expect(options?.credentials).toBe('omit');
    expect(options?.redirect).toBe('error');
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer access-a');
    expect(new Headers(options?.headers).has('Cookie')).toBe(false);
    expect((await context.partitions[0].handler(request('/api/urs/accountinfo'))).status).toBe(403);
  });

  test.each([null, 'user-b:personal:2', 'user-a:enterprise-42:2'])(
    'destroys old DOM and requests before switching to %s, then opens a fresh partition', async next => {
      const context = setup();
      await context.controller.open();
      await context.partitions[0].handler(request());
      const signal = context.network.mock.calls[0][1]?.signal;
      context.controller.invalidateAccount();
      context.setAccount(next);

      expect(context.views[0].webContents.destroyed).toBe(true);
      expect(context.views[0].setVisible).toHaveBeenLastCalledWith(false);
      expect(signal?.aborted).toBe(true);
      expect(context.partitions[0].clearStorageData).toHaveBeenCalledOnce();
      expect(context.partitions[0].protocol.unhandle).toHaveBeenCalledWith('https');
      expect((await context.partitions[0].handler(request())).status).toBe(401);
      expect(context.parent.webContents.send).toHaveBeenLastCalledWith(EmbeddedPricingIpc.StateChanged, EmbeddedPricingState.Closed);
      await context.controller.open();
      expect(context.views).toHaveLength(2);
      expect(electron.fromPartition.mock.calls[0][0]).not.toBe(electron.fromPartition.mock.calls[1][0]);
    },
  );

  test('does not open a delayed pricing request under a different account', async () => {
    const context = setup();
    const pendingUrl = Promise.withResolvers<string>();
    context.resolveLoginUrl.mockReturnValueOnce(pendingUrl.promise);
    const opening = context.controller.open();
    context.controller.invalidateAccount();
    context.setAccount('user-b:personal:2');
    pendingUrl.resolve(`${PortalLoginOrigin.Production}/portal#/login`);

    await expect(opening).resolves.toEqual({ success: false });
    expect(context.views).toHaveLength(0);
  });

  test('does not submit an old order with new credentials if the account changes while reading its body', async () => {
    const context = setup();
    await context.controller.open();
    const body = Promise.withResolvers<ArrayBuffer>();
    const order = new Request(`${PortalLoginOrigin.Production}/api/subscription/create`, { method: 'POST', body: '{}' });
    vi.spyOn(order, 'arrayBuffer').mockReturnValue(body.promise);
    const pending = context.partitions[0].handler(order);
    context.controller.invalidateAccount();
    context.setAccount('user-b:personal:2');
    context.setAccessToken('access-b');
    body.resolve(new ArrayBuffer(0));

    expect((await pending).status).toBe(401);
    expect(context.network).not.toHaveBeenCalled();
  });

  test('drops old response bytes after logout and return to the same account', async () => {
    const context = setup();
    await context.controller.open();
    const body = Promise.withResolvers<ArrayBuffer>();
    const reading = Promise.withResolvers<void>();
    const response = new Response('old account data');
    vi.spyOn(response, 'arrayBuffer').mockImplementation(() => { reading.resolve(); return body.promise; });
    context.network.mockResolvedValueOnce(response);
    const pending = context.partitions[0].handler(request());
    await reading.promise;
    context.controller.invalidateAccount();
    context.setAccount('user-a:personal:3');
    body.resolve(new ArrayBuffer(0));

    expect((await pending).status).toBe(401);
  });

  test('refreshes an expired JWT in main without destroying or changing the page identity', async () => {
    const context = setup();
    await context.controller.open();
    context.network
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { accessToken: 'access-renewed', refreshToken: 'refresh-renewed' } })))
      .mockResolvedValueOnce(new Response('{"code":0}'));

    expect((await context.partitions[0].handler(request())).status).toBe(200);
    expect(new Headers(context.network.mock.calls[2][1]?.headers).get('Authorization')).toBe('Bearer access-renewed');
    expect(context.views[0].webContents.destroyed).toBe(false);
    expect(context.views).toHaveLength(1);
  });

  test('keeps the login completion retry alive while destroying the anonymous page', async () => {
    const context = setup();
    context.setAccount(null);
    await context.controller.open();
    context.views[0].webContents.emit('will-navigate', {
      url: `${PortalLoginOrigin.Production}/portal#/login`, isMainFrame: true, preventDefault: vi.fn(),
    });
    context.controller.invalidateAccount();
    expect(context.views[0].webContents.destroyed).toBe(true);
    expect(context.parent.webContents.send).toHaveBeenLastCalledWith(EmbeddedPricingIpc.StateChanged, EmbeddedPricingState.LoginRequired);
    context.setAccount('user-a:personal:2');
    await context.controller.open();
    expect((await context.partitions[1].handler(request())).status).toBe(200);
  });
});
