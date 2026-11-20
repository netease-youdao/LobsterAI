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
});
