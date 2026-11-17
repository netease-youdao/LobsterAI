import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

import {
  AccountMenuMoreApi,
  AccountMenuMoreIpc,
  type AccountMenuMoreItem,
  AccountMenuMoreItemKind,
  type AccountMenuMoreLinkItem,
  type AccountMenuMoreState,
} from '../../../shared/accountMenuMore/constants';

export const ACCOUNT_MENU_MORE_REQUEST_TIMEOUT_MS = 5_000;
const MAX_ITEMS = 10;

export interface AccountMenuMoreHandlerDeps {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  getServerBaseUrl: () => string;
  fetchPublic: (url: string, init?: RequestInit) => Promise<Response>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

interface RawItem {
  key: string;
  label: string;
  labelEn: string;
  record: Record<string, unknown>;
}

/** Valid, uniquely keyed entries of one menu level, capped like the server. */
function readItems(value: unknown): RawItem[] {
  if (!Array.isArray(value)) return [];
  const items: RawItem[] = [];
  const keys = new Set<string>();
  for (const entry of value.slice(0, MAX_ITEMS)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const key = text(record.key);
    const label = text(record.label);
    if (!key || keys.has(key) || !label) continue;
    keys.add(key);
    items.push({ key, label, labelEn: text(record.labelEn), record });
  }
  return items;
}

function readLinks(value: unknown): AccountMenuMoreLinkItem[] {
  return readItems(value)
    .map(({ key, label, labelEn, record }) => ({
      kind: AccountMenuMoreItemKind.Link,
      key,
      label,
      labelEn,
      url: text(record.url),
    }))
    .filter(link => isHttpsUrl(link.url));
}

/**
 * The renderer opens these URLs with shell.openExternal, so only well-formed
 * https links survive. A non-empty `children` marks a top-level group whose
 * own children are links only; empty groups and an empty menu become null.
 */
export function normalizeAccountMenuMore(data: unknown): AccountMenuMoreState | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (raw.enabled !== true) return null;
  const items: AccountMenuMoreItem[] = [];
  for (const { key, label, labelEn, record } of readItems(raw.items)) {
    if (Array.isArray(record.children) && record.children.length > 0) {
      const children = readLinks(record.children);
      if (children.length > 0) items.push({ kind: AccountMenuMoreItemKind.Group, key, label, labelEn, children });
      continue;
    }
    const url = text(record.url);
    if (isHttpsUrl(url)) items.push({ kind: AccountMenuMoreItemKind.Link, key, label, labelEn, url });
  }
  if (items.length === 0) return null;
  return { items };
}

export function registerAccountMenuMoreHandlers(deps: AccountMenuMoreHandlerDeps): void {
  let lastFailure: string | null = null;
  const warnOnce = (detail: string): void => {
    if (lastFailure === detail) return;
    lastFailure = detail;
    console.warn(`[AccountMenuMore] ${AccountMenuMoreApi.Get} unavailable: ${detail}`);
  };
  const requireMainRenderer = (event: IpcMainInvokeEvent): void => {
    const window = deps.getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Untrusted account menu sender');
    }
  };

  async function request(): Promise<AccountMenuMoreState | null> {
    const server = deps.getServerBaseUrl();
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error('Account menu more request timed out');
        error.name = 'TimeoutError';
        reject(error);
        controller.abort();
      }, ACCOUNT_MENU_MORE_REQUEST_TIMEOUT_MS);
    });
    try {
      // The endpoint is public, so the lookup never waits on a token refresh.
      const lookup = async () => {
        const response = await deps.fetchPublic(`${server}${AccountMenuMoreApi.Get}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          signal: controller.signal,
        });
        const result = await response.json() as { code: number; data?: unknown };
        return { response, result };
      };
      const { response, result } = await Promise.race([lookup(), timeout]);
      if (!response.ok || result.code !== 0) {
        warnOnce(`server=${server}, http=${response.status}, code=${result.code}`);
        return null;
      }
      lastFailure = null;
      return normalizeAccountMenuMore(result.data);
    } catch (error) {
      warnOnce(`server=${server}, failure=${error instanceof Error ? error.name : 'unknown'}`);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  deps.ipcMain.handle(AccountMenuMoreIpc.Get, (event) => {
    requireMainRenderer(event);
    return request();
  });
}
