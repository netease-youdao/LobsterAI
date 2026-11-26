import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DshChannelState,
  RetainedImPlatform,
} from '../../shared/dshEngine/hostConstants';
import {
  WEIXIN_DEFAULT_BASE_URL,
  WeixinQrPollStatus,
} from '../../shared/im/weixin';
import { DEFAULT_WEIXIN_CONFIG, type WeixinOpenClawConfig } from './types';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => '/private/tmp' } }));
vi.mock('./imStore', () => ({
  IMStore: class {
    private config: { weixin: WeixinOpenClawConfig } = {
      weixin: { ...DEFAULT_WEIXIN_CONFIG },
    };

    getConfig() {
      return this.config;
    }

    setConfig(config: Partial<typeof this.config>) {
      if (config.weixin) {
        const next: WeixinOpenClawConfig = { ...this.config.weixin };
        for (const [k, v] of Object.entries(config.weixin) as Array<[keyof WeixinOpenClawConfig, unknown]>) {
          if (v !== undefined) {
            (next as unknown as Record<string, unknown>)[k] = v;
          }
        }
        this.config = { ...this.config, weixin: next };
      }
    }
  },
}));

import { type DshChannelsBridgePort, IMGatewayManager } from './imGatewayManager';

function createMockBridge(overrides: Partial<DshChannelsBridgePort> = {}): DshChannelsBridgePort {
  return {
    isReady: vi.fn(() => true),
    listStatus: vi.fn(async () => ({
      supportedPlatforms: [RetainedImPlatform.Weixin],
      statuses: [],
    })),
    weixinQrStart: vi.fn(async () => ({
      qrcode: 'qr-ticket-1',
      qrcode_img_content: 'https://liteapp.weixin.qq.com/q/test-1',
      qrDataUrl: 'https://liteapp.weixin.qq.com/q/test-1',
    })),
    weixinQrPoll: vi.fn(async () => ({
      status: WeixinQrPollStatus.Confirmed,
      bot_token: 'bot-tok-1',
      ilink_bot_id: 'bot-1@im.bot',
      baseurl: 'https://sz.ilinkai.weixin.qq.com',
      ilink_user_id: 'user-1@im.wechat',
    })),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IMGatewayManager Weixin DSH QR login and status', () => {
  test('starts QR login via DSH channels without OpenClaw RPC, handles IDC redirect, and persists credentials', async () => {
    const events: string[] = [];
    const sync = vi.fn(async () => {
      events.push('sync');
    });
    const poll = vi.fn<DshChannelsBridgePort['weixinQrPoll']>()
      .mockResolvedValueOnce({ status: WeixinQrPollStatus.Wait })
      .mockResolvedValueOnce({
        status: WeixinQrPollStatus.ScannedRedirect,
        redirect_host: 'sz.ilinkai.weixin.qq.com',
      })
      .mockResolvedValueOnce({
        status: WeixinQrPollStatus.Confirmed,
        bot_token: 'secret-ilink-token',
        ilink_bot_id: '91fcaf18cb3a@im.bot',
        baseurl: 'https://sz.ilinkai.weixin.qq.com',
        ilink_user_id: 'wxid_owner@im.wechat',
      });
    const bridge = createMockBridge({
      weixinQrStart: vi.fn(async (params) => {
        events.push('qrStart');
        expect(params).toEqual({
          baseUrl: WEIXIN_DEFAULT_BASE_URL,
          localTokenList: [],
        });
        return {
          qrcode: 'qr-abc',
          qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc',
          qrDataUrl: 'https://liteapp.weixin.qq.com/q/abc',
        };
      }),
      weixinQrPoll: poll,
    });

    const manager = new IMGatewayManager({} as never, {
      syncOpenClawConfig: sync,
      ensureOpenClawGatewayReady: async () => {
        events.push('dshReady');
      },
      getOpenClawGatewayClient: () => null,
      getDshChannelsBridge: () => bridge,
      weixinQrPollIntervalMs: 1,
    });

    const start = await manager.weixinQrLoginStart();
    expect(events).toEqual(['dshReady', 'qrStart']);
    expect(sync).not.toHaveBeenCalled();
    expect(start.qrDataUrl).toBe('https://liteapp.weixin.qq.com/q/abc');
    expect(start.sessionKey).toBeTruthy();
    expect(manager.isWeixinQrLoginActive()).toBe(true);

    const wait = await manager.weixinQrLoginWait(start.sessionKey);
    expect(wait).toMatchObject({
      connected: true,
      alreadyConnected: false,
      accountId: '91fcaf18cb3a@im.bot',
    });
    expect(poll).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ qrcode: 'qr-abc', baseUrl: WEIXIN_DEFAULT_BASE_URL }),
      expect.any(AbortSignal),
    );
    expect(poll).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ qrcode: 'qr-abc', baseUrl: 'https://sz.ilinkai.weixin.qq.com' }),
      expect.any(AbortSignal),
    );
    expect(manager.getConfig().weixin).toMatchObject({
      enabled: true,
      accountId: '91fcaf18cb3a@im.bot',
      botToken: 'secret-ilink-token',
      baseUrl: 'https://sz.ilinkai.weixin.qq.com',
      userId: 'wxid_owner@im.wechat',
    });
    expect(manager.isWeixinQrLoginActive()).toBe(false);
  });

  test('starting a rescan aborts an in-flight QR wait and preserves existing credentials on failure', async () => {
    let firstPollSignal: AbortSignal | undefined;
    let resolveFirstPoll!: () => void;
    const firstPollDeferred = new Promise<void>((resolve) => {
      resolveFirstPoll = resolve;
    });

    const startMock = vi.fn<DshChannelsBridgePort['weixinQrStart']>()
      .mockResolvedValueOnce({
        qrcode: 'qr-1',
        qrcode_img_content: 'https://liteapp.weixin.qq.com/q/1',
      })
      .mockRejectedValueOnce(new Error('network unavailable'));

    const pollMock = vi.fn<DshChannelsBridgePort['weixinQrPoll']>(async (_params, signal) => {
      firstPollSignal = signal;
      await firstPollDeferred;
      return {
        status: WeixinQrPollStatus.Confirmed,
        bot_token: 'stale-token',
        ilink_bot_id: 'stale@im.bot',
      };
    });

    const manager = new IMGatewayManager({} as never, {
      ensureOpenClawGatewayReady: async () => {},
      getDshChannelsBridge: () => createMockBridge({
        weixinQrStart: startMock,
        weixinQrPoll: pollMock,
      }),
      weixinQrPollIntervalMs: 1,
    });

    manager.setConfig({
      weixin: {
        ...DEFAULT_WEIXIN_CONFIG,
        enabled: true,
        accountId: 'existing@im.bot',
        botToken: 'existing-token',
      },
    });

    const first = await manager.weixinQrLoginStart();
    const firstWaitPromise = manager.weixinQrLoginWait(first.sessionKey);
    const firstWaitAssertion = expect(firstWaitPromise).rejects.toThrow();

    await expect(manager.weixinQrLoginStart()).rejects.toThrow('network unavailable');
    expect(firstPollSignal?.aborted).toBe(true);
    resolveFirstPoll();
    await firstWaitAssertion;

    expect(manager.isWeixinQrLoginActive()).toBe(false);
    expect(manager.getConfig().weixin).toMatchObject({
      enabled: true,
      accountId: 'existing@im.bot',
      botToken: 'existing-token',
    });
  });

  test('handles binded_redirect as alreadyConnected only when local token exists', async () => {
    const bridge = createMockBridge({
      weixinQrPoll: vi.fn(async () => ({ status: WeixinQrPollStatus.BindedRedirect })),
    });
    const manager = new IMGatewayManager({} as never, {
      ensureOpenClawGatewayReady: async () => {},
      getDshChannelsBridge: () => bridge,
      weixinQrPollIntervalMs: 1,
    });

    // Migrated account without botToken: must not report alreadyConnected
    manager.setConfig({
      weixin: {
        ...DEFAULT_WEIXIN_CONFIG,
        enabled: true,
        accountId: 'migrated@im.bot',
      },
    });
    const start1 = await manager.weixinQrLoginStart();
    const wait1 = await manager.weixinQrLoginWait(start1.sessionKey);
    expect(wait1.connected).toBe(false);
    expect(wait1.alreadyConnected).toBeFalsy();

    // Account with stored botToken: passes localTokenList and honors binded_redirect
    manager.setConfig({
      weixin: {
        ...DEFAULT_WEIXIN_CONFIG,
        enabled: false,
        accountId: 'bound@im.bot',
        botToken: 'valid-token',
      },
    });
    const start2 = await manager.weixinQrLoginStart();
    expect(bridge.weixinQrStart).toHaveBeenLastCalledWith({
      baseUrl: WEIXIN_DEFAULT_BASE_URL,
      localTokenList: ['valid-token'],
    });
    const wait2 = await manager.weixinQrLoginWait(start2.sessionKey);
    expect(wait2).toMatchObject({
      connected: false,
      alreadyConnected: true,
      accountId: 'bound@im.bot',
    });
    expect(manager.getConfig().weixin.enabled).toBe(true);
  });

  test('rejects foreign session keys without polling and handles expired QR codes', async () => {
    const bridge = createMockBridge({
      weixinQrPoll: vi.fn(async () => ({ status: WeixinQrPollStatus.Expired })),
    });
    const manager = new IMGatewayManager({} as never, {
      ensureOpenClawGatewayReady: async () => {},
      getDshChannelsBridge: () => bridge,
      weixinQrPollIntervalMs: 1,
    });

    await expect(manager.weixinQrLoginWait('foreign')).rejects.toThrow();
    expect(bridge.weixinQrPoll).not.toHaveBeenCalled();

    const start = await manager.weixinQrLoginStart();
    await expect(manager.weixinQrLoginWait('wrong-key')).rejects.toThrow();
    expect(bridge.weixinQrPoll).not.toHaveBeenCalled();

    const expired = await manager.weixinQrLoginWait(start.sessionKey);
    expect(expired.connected).toBe(false);
    expect(manager.isWeixinQrLoginActive()).toBe(false);
  });

  test('enriches Weixin status and connectivity test from DSH channels rather than assuming enabled === connected', async () => {
    const bridge = createMockBridge({
      listStatus: vi.fn(async () => ({
        supportedPlatforms: [RetainedImPlatform.Weixin],
        statuses: [
          {
            platform: RetainedImPlatform.Weixin,
            instanceId: 'default',
            state: DshChannelState.Connected,
            error: null,
            botInfo: { accountId: 'live@im.bot' },
            startedAt: 1_700_000_000_000,
            lastInboundAt: 1_700_000_001_000,
            lastOutboundAt: 1_700_000_002_000,
          },
        ],
      })),
    });

    const manager = new IMGatewayManager({} as never, {
      getDshChannelsBridge: () => bridge,
    });

    // Migrated state: enabled=true with accountId but no botToken -> disconnected + not configured error
    manager.setConfig({
      weixin: {
        ...DEFAULT_WEIXIN_CONFIG,
        enabled: true,
        accountId: '91fcaf18cb3a@im.bot',
      },
    });
    const baseStatus = manager.getStatus();
    expect(baseStatus.weixin.connected).toBe(false);
    expect(baseStatus.weixin.lastError?.toLowerCase()).toContain('not configured');

    const missingCredTest = await manager.testGateway('weixin');
    expect(missingCredTest.verdict).toBe('fail');
    expect(missingCredTest.checks[0]?.code).toBe('missing_credentials');

    // Configured with token -> enriched from DSH runtime
    manager.setConfig({
      weixin: {
        ...DEFAULT_WEIXIN_CONFIG,
        enabled: true,
        accountId: 'live@im.bot',
        botToken: 'live-token',
      },
    });
    const enriched = await manager.getStatusWithOpenClawRuntime();
    expect(enriched.weixin).toMatchObject({
      connected: true,
      accountId: 'live@im.bot',
      startedAt: 1_700_000_000_000,
      lastInboundAt: 1_700_000_001_000,
      lastOutboundAt: 1_700_000_002_000,
      lastError: null,
    });

    const liveTest = await manager.testGateway('weixin');
    expect(liveTest.verdict).toBe('pass');
  });

  test.each([
    ['Weixin session expired (errcode=-14), please re-scan QR code', 'fail'],
    ['Weixin getupdates HTTP 503', 'warn'],
  ])('classifies the live driver error %s', async (error, verdict) => {
    const bridge = createMockBridge({ listStatus: async () => ({
      supportedPlatforms: [RetainedImPlatform.Weixin],
      statuses: [{ platform: RetainedImPlatform.Weixin, instanceId: 'default', state: DshChannelState.Error, error }],
    }) });
    const manager = new IMGatewayManager({} as never, { getDshChannelsBridge: () => bridge });
    manager.setConfig({ weixin: { ...DEFAULT_WEIXIN_CONFIG, enabled: true, accountId: 'bot', botToken: 'saved' } });
    expect(manager.getStatus().weixin.connected).toBe(false);
    expect((await manager.getStatusWithOpenClawRuntime()).weixin.lastError).toBe(error);
    const result = await manager.testGateway(RetainedImPlatform.Weixin);
    expect(result.verdict).toBe(verdict);
    if (verdict === 'fail') {
      expect(result.checks).toEqual([expect.objectContaining({ code: 'auth_check', level: 'fail' })]);
      expect(result.checks[0].message).not.toContain('errcode');
    }
  });
});
