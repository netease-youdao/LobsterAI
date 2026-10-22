import crypto from 'crypto';
import { type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, session, WebContentsView } from 'electron';

import type { AuthLoginViewBounds } from '../../../shared/auth/constants';
import {
  ClientAccountLayout,
  EmbeddedPortalPage,
  EmbeddedPricingIpc,
  type EmbeddedPricingOptions,
  EmbeddedPricingState,
} from '../../../shared/payment/embeddedPricing';
import { revealEmbeddedPortal } from '../embeddedLogin/embeddedPortalPresentation';
import { isExternalLinkAllowed, PortalLoginOrigin } from '../embeddedLogin/loginUrlPolicy';

const API_PATHS = ['/api/plans', '/api/boost-packs', '/api/subscription', '/api/subscription-trial',
  '/api/payment', '/api/purchase-offers', '/api/recharge-campaign', '/api/enterprise/orders'];
const READ_ONLY_API_PATHS = new Set(['/api/auth/status', '/api/user/profile',
  '/api/models/showcase', '/api/models/pricing-catalog', '/api/enterprise/purchase-config',
  '/api/enterprise/purchase-eligibility', '/api/enterprise/context']);
const PAYMENT_ROUTES = new Set(['/', '/pricing', '/wechat-sign', '/enterprise/purchase', '/enterprise/purchase-success']);
const OPTION_PARAMS = {
  keyfrom: 'keyfrom', traceId: 'trace_id', offerToken: 'offerToken', tab: 'tab', banner: 'banner',
  trialCampaign: 'trialCampaign', trialCheckout: 'trialCheckout', amount: 'amount',
} as const;

interface EmbeddedPricingDeps {
  ipcMain: IpcMain;
  getMainWindow(): BrowserWindow | null;
  resolveLoginUrl(): Promise<string>;
  getServerBaseUrl(): string;
  getAccountKey(): string | null;
  fetchWithAuth(url: string, options?: RequestInit): Promise<Response>;
  fetchPublic(url: string, options?: RequestInit): Promise<Response>;
  openExternal(url: string): void;
}

function routeUrl(url: URL): URL {
  return url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : url;
}

function normalizeOptions(value: unknown): EmbeddedPricingOptions {
  const result: Record<string, string> = {};
  if (value && typeof value === 'object') {
    for (const key of Object.keys(OPTION_PARAMS)) {
      const item = (value as Record<string, unknown>)[key];
      if (typeof item === 'string' && item.length <= 4096) result[key] = item;
    }
  }
  if (result.tab && !['subscription', 'boost', 'team'].includes(result.tab)) delete result.tab;
  return result as EmbeddedPricingOptions;
}

/** Existing recharge, trial and upgrade links all enter the same in-client pricing surface. */
export function pricingOptionsFromUrl(raw: string): EmbeddedPricingOptions | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password
      || !Object.values(PortalLoginOrigin).some(origin => origin === url.origin)) return null;
    if (url.hash.startsWith('#/') && !['/portal', '/portal/'].includes(url.pathname)) return null;
    if (!url.hash.startsWith('#/') && url.pathname !== '/pricing') return null;
    const route = routeUrl(url);
    if (!['/', '/pricing'].includes(route.pathname)) return null;
    const options: Record<string, string> = {};
    for (const [key, param] of Object.entries(OPTION_PARAMS)) {
      const value = route.searchParams.get(param);
      if (value) options[key] = value;
    }
    return normalizeOptions(options);
  } catch {
    return null;
  }
}

/** Remote pricing keeps its existing quote/order/QR lifecycle; credentials and retries stay in main. */
export function registerEmbeddedPricingIpcHandlers(deps: EmbeddedPricingDeps) {
  let generation = 0;
  let dispose: (() => void) | null = null;
  let updateBounds: ((bounds: AuthLoginViewBounds) => void) | null = null;
  let lastOptions: EmbeddedPricingOptions = {};
  let currentState: EmbeddedPricingState = EmbeddedPricingState.Closed;

  const emit = (state: EmbeddedPricingState): void => {
    currentState = state;
    const parent = deps.getMainWindow();
    if (parent && !parent.isDestroyed()) parent.webContents.send(EmbeddedPricingIpc.StateChanged, state);
  };
  const disposeView = (): void => {
    generation += 1;
    dispose?.();
    dispose = null;
    updateBounds = null;
  };
  const close = (): void => {
    disposeView();
    emit(EmbeddedPricingState.Closed);
  };
  const invalidateAccount = (): void => {
    // Destroy remote DOM, QR codes and pending work before changing credentials.
    // Keep an in-progress login's placeholder so its existing completion retries
    // pricing with a fresh partition bound to the newly authenticated account.
    disposeView();
    if (currentState !== EmbeddedPricingState.LoginRequired) emit(EmbeddedPricingState.Closed);
  };

  const open = async (input?: unknown): Promise<{ success: boolean; error?: string }> => {
    disposeView();
    if (input !== undefined) lastOptions = normalizeOptions(input);
    const attempt = generation;
    const accountKey = deps.getAccountKey();
    const isCurrent = (): boolean => attempt === generation && deps.getAccountKey() === accountKey;
    emit(EmbeddedPricingState.Loading);
    try {
      const entry = new URL(await deps.resolveLoginUrl());
      const parent = deps.getMainWindow();
      if (!isCurrent() || !parent || parent.isDestroyed()) return { success: false };
      const route = routeUrl(entry);
      route.pathname = '/pricing';
      route.search = '';
      route.searchParams.set('desktop', '1');
      for (const [key, param] of Object.entries(OPTION_PARAMS)) {
        const value = lastOptions[key as keyof EmbeddedPricingOptions];
        if (value) route.searchParams.set(param, value);
      }
      if (entry.hash.startsWith('#/')) entry.hash = route.pathname + route.search;
      else { entry.pathname = route.pathname; entry.search = route.search; }

      const portalOrigin = entry.origin;
      const apiBase = new URL(deps.getServerBaseUrl());
      const partition = session.fromPartition(`lobsterai-pricing-${crypto.randomUUID()}`);
      const abort = new AbortController();
      const parentContents = parent.webContents;
      let headerHeight = ClientAccountLayout.HeaderHeight * parentContents.getZoomFactor();
      const view = new WebContentsView({ webPreferences: {
        session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, navigateOnDragDrop: false, spellcheck: false,
      } });
      const contents = view.webContents;
      view.setBackgroundColor(ClientAccountLayout.Background);
      view.setVisible(false);
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      partition.setPermissionCheckHandler(() => false);
      partition.on('will-download', event => event.preventDefault());

      // A partition-local protocol bridge never exposes the client's bearer token to Portal JavaScript.
      // Only pricing/auth-status APIs can use the account that opened this view, with normal auth refresh.
      partition.protocol.handle('https', async request => {
        const url = new URL(request.url);
        if (![apiBase.origin, portalOrigin].includes(url.origin) || !url.pathname.startsWith('/api/')) {
          return partition.fetch(request, { bypassCustomProtocolHandlers: true });
        }
        const cors = {
          'Access-Control-Allow-Origin': portalOrigin,
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        };
        const fail = (status: number) => new Response(null, { status, headers: cors });
        if (!isCurrent()) return fail(401);
        const origin = request.headers.get('Origin');
        if (origin && origin !== portalOrigin) return fail(403);
        const allowedPath = API_PATHS.some(path => url.pathname === path || url.pathname.startsWith(`${path}/`))
          || (['GET', 'OPTIONS'].includes(request.method) && READ_ONLY_API_PATHS.has(url.pathname));
        if (!allowedPath) return fail(403);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (request.method !== 'GET' && request.method !== 'POST') return fail(405);
        try {
          const headers = new Headers({ Accept: 'application/json' });
          const contentType = request.headers.get('Content-Type');
          if (contentType) headers.set('Content-Type', contentType);
          const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;
          if (!isCurrent()) return fail(401);
          const fetcher = accountKey ? deps.fetchWithAuth : deps.fetchPublic;
          const response = await fetcher(`${apiBase.origin}${url.pathname}${url.search}`, {
            method: request.method, headers, credentials: 'omit', redirect: 'error',
            body,
            signal: AbortSignal.any([abort.signal, request.signal, AbortSignal.timeout(30_000)]),
          });
          if (!isCurrent()) return fail(401);
          const responseBody = response.status === 204 ? null : await response.arrayBuffer();
          if (!isCurrent()) return fail(401);
          return new Response(responseBody, {
            status: response.status,
            headers: { ...cors, 'Content-Type': response.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' },
          });
        } catch {
          return fail(502);
        }
      });

      const resize = (): void => {
        if (parent.isDestroyed() || contents.isDestroyed()) return;
        const { width, height } = parent.getContentBounds();
        view.setBounds({ x: 0, y: Math.min(headerHeight, height), width, height: Math.max(0, height - headerHeight) });
      };
      updateBounds = bounds => {
        if (!Object.values(bounds).every(Number.isFinite)) return;
        headerHeight = Math.max(36, Math.round(bounds.y * parentContents.getZoomFactor()));
        resize();
      };
      const onParentNavigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
        if (mainFrame) close();
      };
      dispose = () => {
        abort.abort();
        view.setVisible(false);
        parent.removeListener('resize', resize);
        parent.removeListener('closed', close);
        parentContents.removeListener('did-start-navigation', onParentNavigation);
        if (!parent.isDestroyed()) { parent.contentView.removeChildView(view); parentContents.focus(); }
        if (!contents.isDestroyed()) contents.close();
        partition.protocol.unhandle('https');
        void partition.clearStorageData().catch((): void => undefined);
        void partition.clearCache().catch((): void => undefined);
      };
      parent.contentView.addChildView(view);
      parent.on('resize', resize);
      parent.on('closed', close);
      parentContents.on('did-start-navigation', onParentNavigation);
      resize();

      const checkNavigation = (raw: string): boolean => {
        let url: URL;
        try { url = new URL(raw); } catch { return false; }
        if (url.origin !== portalOrigin || url.username || url.password) return false;
        if (entry.hash.startsWith('#/') && url.pathname.replace(/\/$/, '') !== entry.pathname.replace(/\/$/, '')) return false;
        const path = routeUrl(url).pathname;
        if (path === '/login') {
          view.setVisible(false);
          emit(EmbeddedPricingState.LoginRequired);
          return false;
        }
        return PAYMENT_ROUTES.has(path) || /^\/enterprise\/console\/[1-9]\d*\/recharge$/.test(path);
      };
      const onNavigation = (event: { url: string; isMainFrame: boolean; preventDefault(): void }): void => {
        if (event.isMainFrame && !checkNavigation(event.url)) event.preventDefault();
      };
      contents.on('will-navigate', onNavigation);
      contents.on('will-redirect', onNavigation);
      contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
        if (mainFrame && !checkNavigation(url) && routeUrl(new URL(url)).pathname !== '/login') {
          view.setVisible(false);
          void contents.loadURL(entry.toString()).catch((): void => undefined);
        }
      });
      contents.setWindowOpenHandler(({ url }) => {
        if (checkNavigation(url)) void contents.loadURL(url).catch((): void => undefined);
        else if (isExternalLinkAllowed(url) && new URL(url).hostname === 'c.youdao.com') deps.openExternal(url);
        return { action: 'deny' };
      });
      contents.on('before-input-event', (event, input) => {
        if (input.key === 'Escape') { event.preventDefault(); close(); }
      });
      contents.on('dom-ready', () => {
        if (attempt !== generation || !checkNavigation(contents.getURL())) return;
        void revealEmbeddedPortal(view, portalOrigin, EmbeddedPortalPage.Pricing)
          .then(() => { if (attempt === generation) emit(EmbeddedPricingState.Ready); })
          .catch(() => { if (attempt === generation) emit(EmbeddedPricingState.Error); });
      });
      contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
        if (mainFrame && code !== -3 && attempt === generation) {
          view.setVisible(false);
          emit(EmbeddedPricingState.Error);
        }
      });
      void contents.loadURL(entry.toString()).catch((): void => undefined);
      return { success: true };
    } catch (error) {
      if (attempt === generation) {
        dispose?.();
        dispose = null;
        emit(EmbeddedPricingState.Error);
      }
      console.error('[Payment] failed to open embedded pricing', error);
      return { success: false, error: 'Unable to open pricing' };
    }
  };

  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const parent = deps.getMainWindow();
    return Boolean(parent && !parent.isDestroyed() && event.sender === parent.webContents
      && event.senderFrame === parent.webContents.mainFrame);
  };
  deps.ipcMain.handle(EmbeddedPricingIpc.Open, (event, options: unknown) => trusted(event) ? open(options) : { success: false });
  deps.ipcMain.handle(EmbeddedPricingIpc.Close, event => { if (trusted(event)) close(); });
  deps.ipcMain.handle(EmbeddedPricingIpc.SetBounds, (event, bounds: unknown) => {
    if (!trusted(event) || !bounds || typeof bounds !== 'object') return;
    const { x, y, width, height } = bounds as Record<string, unknown>;
    if (typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number') {
      updateBounds?.({ x, y, width, height });
    }
  });
  return { open, close, invalidateAccount };
}
