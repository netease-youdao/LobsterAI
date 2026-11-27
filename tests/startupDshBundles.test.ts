import { describe, expect, test, vi } from 'vitest';

import { ChannelManager } from '../dsh-bundles/lobsterai-channels/plugins/channel-registry.mjs';
import { createMcpSseBridgeController } from '../dsh-bundles/lobsterai-host/plugins/mcp-sse-bridge-helpers.mjs';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('DSH startup bundle optimizations', () => {
  test('createMcpSseBridgeController.sync returns immediately when awaitInitialReady is false', async () => {
    const connectGate = deferred<void>();
    const connectSpy = vi.fn(() => connectGate.promise);
    const bridge = createMcpSseBridgeController(
      {
        tools: { register: () => () => undefined },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      },
      {
        createClient: () => ({
          connect: connectSpy,
          listTools: async () => ({ tools: [] }),
          callTool: async () => ({ content: [] }),
          close: async () => undefined,
        }),
        createTransport: () => ({ close: async () => undefined }),
        initialSyncWaitMs: 5_000,
      },
    );

    try {
      const result = await bridge.sync(
        [
          {
            name: 'slow-sse',
            transport: 'sse',
            url: 'https://mcp.example.com/sse',
            startupTimeoutMs: 5_000,
          },
        ],
        { awaitInitialReady: false },
      );

      expect(result.registered).toEqual(['slow-sse']);
      expect(result.errors).toEqual([]);
      expect(connectSpy).toHaveBeenCalledTimes(1);
    } finally {
      connectGate.resolve();
      await bridge.disposeAll();
    }
  });

  test('ChannelManager.syncInstances starts multiple IM instances in parallel', async () => {
    const startedOrder: string[] = [];
    const gateA = deferred<void>();
    const gateB = deferred<void>();

    const { FeishuChannelDriver } = await import(
      '../dsh-bundles/lobsterai-channels/plugins/drivers/feishu.mjs'
    );
    const { TelegramChannelDriver } = await import(
      '../dsh-bundles/lobsterai-channels/plugins/drivers/telegram.mjs'
    );

    const feishuStart = vi
      .spyOn(FeishuChannelDriver.prototype, 'start')
      .mockImplementation(async () => {
        startedOrder.push('feishu:begin');
        await gateA.promise;
        startedOrder.push('feishu:end');
      });
    const telegramStart = vi
      .spyOn(TelegramChannelDriver.prototype, 'start')
      .mockImplementation(async () => {
        startedOrder.push('telegram:begin');
        await gateB.promise;
        startedOrder.push('telegram:end');
      });
    vi.spyOn(FeishuChannelDriver.prototype, 'stop').mockResolvedValue(undefined);
    vi.spyOn(TelegramChannelDriver.prototype, 'stop').mockResolvedValue(undefined);

    const manager = new ChannelManager({ ctx: {} });
    try {
      const syncPromise = manager.syncInstances([
        { platform: 'feishu', instanceId: 'a', enabled: true, config: { appId: '1', appSecret: '2' } },
        { platform: 'telegram', instanceId: 'b', enabled: true, config: { botToken: 'tok' } },
      ]);

      // Wait a microtask tick: BOTH drivers must have begun starting before either resolves.
      await new Promise((r) => setTimeout(r, 10));
      expect(startedOrder).toEqual(['feishu:begin', 'telegram:begin']);

      gateB.resolve();
      gateA.resolve();

      const result = await syncPromise;
      expect(result.started).toEqual(['feishu:a', 'telegram:b']);
      expect(result.errors).toEqual([]);
      expect(feishuStart).toHaveBeenCalledTimes(1);
      expect(telegramStart).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      await manager.dispose();
    }
  });
});
