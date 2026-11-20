import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { AccountMenuMoreIpc } from '../../../shared/accountMenuMore/constants';
import {
  ACCOUNT_MENU_MORE_REQUEST_TIMEOUT_MS,
  normalizeAccountMenuMore,
  registerAccountMenuMoreHandlers,
} from './handlers';

type Handler = (event: IpcMainInvokeEvent) => Promise<unknown>;
const response = (code: number, data: unknown = null, status = 200) => (
  new Response(JSON.stringify({ code, data }), { status })
);
const billing = {
  key: 'billing',
  label: '账单与发票',
  labelEn: 'Billing & invoices',
  url: 'https://lobsterai.youdao.com/portal#/subscription',
};
const billingLink = { kind: 'link', ...billing };

function harness() {
  const handlers = new Map<string, Handler>();
  const mainFrame = {};
  const webContents = { mainFrame };
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const fetchPublic = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  registerAccountMenuMoreHandlers({
    ipcMain: { handle: (key: string, value: Handler) => handlers.set(key, value) } as unknown as IpcMain,
    getMainWindow: () => ({ isDestroyed: () => false, webContents }) as unknown as BrowserWindow,
    getServerBaseUrl: () => 'https://server.example',
    fetchPublic,
  });
  return {
    fetchPublic,
    invoke: () => handlers.get(AccountMenuMoreIpc.Get)!(event),
    invokeFrom: (other: IpcMainInvokeEvent) => handlers.get(AccountMenuMoreIpc.Get)!(other),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('normalizeAccountMenuMore', () => {
  test('keeps enabled https items with their localized labels and ignores extra fields', () => {
    expect(normalizeAccountMenuMore({ enabled: true, title: '更多', items: [{ ...billing, icon: 'billing' }] }))
      .toEqual({ items: [billingLink] });
  });

  test('hides disabled, empty, and unknown payloads', () => {
    expect(normalizeAccountMenuMore(null)).toBeNull();
    expect(normalizeAccountMenuMore({ enabled: false, items: [billing] })).toBeNull();
    expect(normalizeAccountMenuMore({ enabled: true, items: [] })).toBeNull();
    expect(normalizeAccountMenuMore({ enabled: true, items: 'billing' })).toBeNull();
  });

  test('drops items that could not be opened safely', () => {
    const state = normalizeAccountMenuMore({
      enabled: true,
      items: [
        billing,
        { ...billing },
        { ...billing, key: 'http', url: 'http://lobsterai.youdao.com' },
        { ...billing, key: 'script', url: 'javascript:alert(1)' },
        { ...billing, key: 'file', url: 'file:///etc/passwd' },
        { ...billing, key: 'nolabel', label: ' ' },
        'redemption',
      ],
    });
    expect(state?.items.map(item => item.key)).toEqual(['billing']);
  });

  test('keeps one level of groups and drops empty or nested ones', () => {
    const state = normalizeAccountMenuMore({
      enabled: true,
      items: [
        { ...billing, children: [] },
        {
          key: 'legal',
          label: '法律条款',
          labelEn: 'Legal',
          children: [
            { ...billing, key: 'privacy' },
            { ...billing, key: 'unsafe', url: 'http://lobsterai.youdao.com' },
            { key: 'nested', label: '嵌套', children: [billing] },
          ],
        },
        { key: 'empty', label: '空分组', children: [{ ...billing, url: 'javascript:alert(1)' }] },
      ],
    });
    expect(state).toEqual({
      items: [
        billingLink,
        {
          kind: 'group',
          key: 'legal',
          label: '法律条款',
          labelEn: 'Legal',
          children: [{ ...billingLink, key: 'privacy' }],
        },
      ],
    });
  });
});

describe('registerAccountMenuMoreHandlers', () => {
  test('loads the menu from the public endpoint', async () => {
    const h = harness();
    h.fetchPublic.mockResolvedValue(response(0, { enabled: true, items: [billing] }));
    expect(await h.invoke()).toEqual({ items: [billingLink] });
    expect(h.fetchPublic).toHaveBeenCalledWith(
      'https://server.example/api/client-menu/account-more',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('an older server without the endpoint hides the entry with one diagnostic', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    h.fetchPublic.mockImplementation(async () => response(40100, null, 401));
    expect(await h.invoke()).toBeNull();
    expect(await h.invoke()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('http=401, code=40100');
  });

  test('network failures are hidden without leaking transport details', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    h.fetchPublic.mockRejectedValue(new TypeError('private transport detail'));
    expect(await h.invoke()).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toContain('failure=TypeError');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private transport detail');
  });

  test('times out a stalled lookup and aborts its request', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    h.fetchPublic.mockImplementation(() => new Promise<Response>(() => undefined));
    const pending = h.invoke();
    const signal = h.fetchPublic.mock.calls[0]?.[1]?.signal;
    await vi.advanceTimersByTimeAsync(ACCOUNT_MENU_MORE_REQUEST_TIMEOUT_MS);
    expect(await pending).toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  test('rejects senders other than the main window', () => {
    const h = harness();
    const other = { sender: {}, senderFrame: {} } as unknown as IpcMainInvokeEvent;
    expect(() => h.invokeFrom(other)).toThrow('Untrusted account menu sender');
    expect(h.fetchPublic).not.toHaveBeenCalled();
  });
});
