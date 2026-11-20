import { describe, expect, test, vi } from 'vitest';

import {
  RETAINED_IM_PLATFORM_LIST,
  RetainedImPlatform,
  RetiredImPlatform,
} from '../../shared/dshEngine/hostConstants';
import {
  DshChannelsBridge,
  filterRetainedChannelInstances,
  isRetainedImPlatform,
} from './dshChannelsBridge';

describe('dshChannelsBridge', () => {
  test('accepts the 7 retained mainstream platforms and excludes POPO/NIM/Bee/Email', () => {
    for (const p of RETAINED_IM_PLATFORM_LIST) {
      expect(isRetainedImPlatform(p)).toBe(true);
    }
    expect(isRetainedImPlatform(RetiredImPlatform.Popo)).toBe(false);
    expect(isRetainedImPlatform(RetiredImPlatform.Nim)).toBe(false);
    expect(isRetainedImPlatform(RetiredImPlatform.NeteaseBee)).toBe(false);
    expect(isRetainedImPlatform(RetiredImPlatform.Email)).toBe(false);
  });

  test('filters retired IM platforms cleanly when syncing to @lobsterai/dsh-channels', async () => {
    const filtered = filterRetainedChannelInstances([
      { platform: RetainedImPlatform.Feishu, instanceId: 'f1', config: { appId: 'a' } },
      { platform: RetainedImPlatform.Telegram, instanceId: 't1', config: { botToken: 'b' } },
      { platform: RetiredImPlatform.Popo, instanceId: 'p1', config: {} },
      { platform: RetiredImPlatform.Email, instanceId: 'e1', config: {} },
    ]);
    expect(filtered.retained.map((r) => r.platform)).toEqual(['feishu', 'telegram']);
    expect(filtered.skippedRetiredPlatforms).toEqual(['popo', 'email']);

    const requester = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body ?? '{}') as { action: string; payload?: { instances?: unknown[] } };
      expect(body.action).toBe('syncInstances');
      expect(body.payload?.instances).toHaveLength(2);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          ok: true,
          result: { started: ['feishu:f1', 'telegram:t1'], stopped: [], errors: [], statuses: [] },
        }),
      };
    });

    const bridge = new DshChannelsBridge({
      hostManager: {
        isReady: () => true,
        getClient: () => ({ getOrigin: () => 'http://127.0.0.1:50000' }) as never,
        getStatus: () => ({}) as never,
      },
      requester,
    });

    const res = await bridge.syncInstances([
      { platform: 'feishu', instanceId: 'f1', config: { appId: 'a' } },
      { platform: 'telegram', instanceId: 't1', config: { botToken: 'b' } },
      { platform: 'popo', instanceId: 'p1', config: {} },
    ]);
    expect(res.started).toEqual(['feishu:f1', 'telegram:t1']);
    expect(res.skippedRetiredPlatforms).toEqual(['popo']);
  });

  test('normalizes legacy channel aliases in sendProactiveMessage and rejects retired platforms', async () => {
    const sentPayloads: Array<{ platform: string; chatId: string }> = [];
    const requester = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body ?? '{}') as {
        action: string;
        payload: { platform: string; chatId: string };
      };
      sentPayloads.push(body.payload);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: true, result: { delivered: true } }),
      };
    });

    const bridge = new DshChannelsBridge({
      hostManager: {
        isReady: () => true,
        getClient: () => ({ getOrigin: () => 'http://127.0.0.1:50000' }) as never,
        getStatus: () => ({}) as never,
      },
      requester,
    });

    await bridge.sendProactiveMessage({
      platform: 'openclaw-weixin',
      chatId: 'user@im.wechat',
      text: 'hello',
    });
    await bridge.sendProactiveMessage({
      platform: 'dingtalk-connector',
      chatId: 'cid123',
      text: 'hi',
    });
    expect(sentPayloads.map((p) => p.platform)).toEqual(['weixin', 'dingtalk']);

    await expect(
      bridge.sendProactiveMessage({
        platform: 'moltbot-popo',
        chatId: 'u1',
        text: 'nope',
      }),
    ).rejects.toThrow(/retired/);
  });

  test('forwards Weixin QR start and abortable poll actions to /api/lobsterai/channels', async () => {
    const receivedSignals: Array<AbortSignal | undefined> = [];
    const requester = vi.fn(async (_url, init) => {
      receivedSignals.push(init.signal);
      const body = JSON.parse(init.body ?? '{}') as { action: string; payload?: Record<string, unknown> };
      if (body.action === 'weixinQrStart') {
        expect(body.payload).toEqual({
          baseUrl: 'https://ilinkai.weixin.qq.com',
          localTokenList: ['tok-1'],
        });
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            ok: true,
            result: {
              qrcode: 'qr-123',
              qrcode_img_content: 'https://liteapp.weixin.qq.com/q/123',
              qrDataUrl: 'https://liteapp.weixin.qq.com/q/123',
            },
          }),
        };
      }
      expect(body.action).toBe('weixinQrPoll');
      expect(body.payload).toEqual({
        qrcode: 'qr-123',
        baseUrl: 'https://sz.ilinkai.weixin.qq.com',
        timeoutMs: 35_000,
      });
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          ok: true,
          result: { status: 'confirmed', bot_token: 'tok-2', ilink_bot_id: 'bot@im.bot' },
        }),
      };
    });

    const bridge = new DshChannelsBridge({
      hostManager: {
        isReady: () => true,
        getClient: () => ({ getOrigin: () => 'http://127.0.0.1:50000' }) as never,
        getStatus: () => ({}) as never,
      },
      requester,
    });

    expect(bridge.isReady()).toBe(true);
    const start = await bridge.weixinQrStart({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      localTokenList: ['tok-1'],
    });
    expect(start.qrcode).toBe('qr-123');
    expect(start.qrDataUrl).toBe('https://liteapp.weixin.qq.com/q/123');

    const controller = new AbortController();
    const poll = await bridge.weixinQrPoll(
      { qrcode: 'qr-123', baseUrl: 'https://sz.ilinkai.weixin.qq.com', timeoutMs: 35_000 },
      controller.signal,
    );
    expect(poll.status).toBe('confirmed');
    expect(poll.bot_token).toBe('tok-2');
    expect(receivedSignals[1]).toBe(controller.signal);
  });
});
