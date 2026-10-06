import { afterEach, expect, test, vi } from 'vitest';

import { WeixinPlugin, WeixinQrLoginTimeout } from '../../shared/im/weixin';
import { DEFAULT_WEIXIN_CONFIG } from './types';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => '/private/tmp' } }));
vi.mock('./nimGateway', () => ({ NimGateway: class {} }));
vi.mock('./imStore', () => ({
  IMStore: class {
    private config = { weixin: { ...DEFAULT_WEIXIN_CONFIG } };
    getConfig() { return this.config; }
    setConfig(config: Partial<typeof this.config>) { this.config = { ...this.config, ...config }; }
  },
}));

import { IMGatewayManager } from './imGatewayManager';

afterEach(() => { vi.restoreAllMocks(); });

test('first QR login activates before readiness/RPC and successful login persists the channel', async () => {
  const events: string[] = [];
  const rpc = vi.fn(async (method: string) => {
    events.push(method);
    return method === WeixinPlugin.LoginStart
      ? { qrDataUrl: 'qr', sessionKey: 'one', message: 'scan' }
      : { connected: true, accountId: 'account', message: 'connected' };
  });
  const sync = vi.fn(async () => {
    expect(manager.isWeixinQrLoginActive()).toBe(true);
    expect(manager.getConfig().weixin.enabled).toBe(false);
    events.push('sync');
  });
  const manager = new IMGatewayManager({} as never, {
    syncOpenClawConfig: sync,
    ensureOpenClawGatewayReady: async () => { events.push('ready'); },
    getOpenClawGatewayClient: () => ({ request: rpc } as never),
  });
  await manager.weixinQrLoginStart();
  expect(events).toEqual(['sync', 'ready', WeixinPlugin.LoginStart]);
  expect(rpc).toHaveBeenCalledWith(WeixinPlugin.LoginStart, {
    channel: WeixinPlugin.Id, force: true, timeoutMs: WeixinQrLoginTimeout.Start, verbose: true,
  }, { timeoutMs: WeixinQrLoginTimeout.Start + WeixinQrLoginTimeout.RpcGrace });
  await expect(manager.weixinQrLoginWait('one')).resolves.toMatchObject({ connected: true, accountId: 'account' });
  expect(rpc).toHaveBeenCalledWith(WeixinPlugin.LoginWait, {
    channel: WeixinPlugin.Id, timeoutMs: WeixinQrLoginTimeout.Wait, accountId: 'one',
  }, { timeoutMs: WeixinQrLoginTimeout.Wait + WeixinQrLoginTimeout.RpcGrace });
  expect(manager.getConfig().weixin).toMatchObject({ enabled: true, accountId: 'account' });
  expect(manager.isWeixinQrLoginActive()).toBe(false);
  expect(sync).toHaveBeenCalledOnce();
});

test('failed first login restores the disabled plugin and preserves existing account credentials', async () => {
  const states: boolean[] = [];
  const manager = new IMGatewayManager({} as never, {
    syncOpenClawConfig: async () => { states.push(manager.isWeixinQrLoginActive()); },
    ensureOpenClawGatewayReady: async () => {},
    getOpenClawGatewayClient: () => ({ request: async () => ({ message: 'failed' }) } as never),
  });
  manager.setConfig({ weixin: { ...DEFAULT_WEIXIN_CONFIG, accountId: 'preserved' } });
  await expect(manager.weixinQrLoginStart()).rejects.toThrow('failed');
  expect(states).toEqual([true, false]);
  expect(manager.getConfig().weixin).toMatchObject({ enabled: false, accountId: 'preserved' });
});

test('rejects a foreign QR response without a Weixin session and preserves the existing account', async () => {
  const rpc = vi.fn(async () => ({ qrDataUrl: 'qq-qr', message: 'Scan with QQ' }));
  const manager = new IMGatewayManager({} as never, {
    syncOpenClawConfig: async () => {},
    ensureOpenClawGatewayReady: async () => {},
    getOpenClawGatewayClient: () => ({ request: rpc } as never),
  });
  manager.setConfig({ weixin: { ...DEFAULT_WEIXIN_CONFIG, enabled: true, accountId: 'existing' } });
  await expect(manager.weixinQrLoginStart()).rejects.toThrow();
  expect(manager.isWeixinQrLoginActive()).toBe(false);
  expect(manager.getConfig().weixin).toMatchObject({ enabled: true, accountId: 'existing' });
  await expect(manager.weixinQrLoginWait('foreign')).rejects.toThrow();
  expect(rpc).toHaveBeenCalledOnce();
});
