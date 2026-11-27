import { describe, expect, test, vi } from 'vitest';

const REGISTRY_PATH = '../dsh-bundles/lobsterai-channels/plugins/channel-registry.mjs';

function makeFakeEntry(label: string) {
  return {
    driver: {
      sendMessage: vi.fn(async (msg: { chatId: string; text: string }) => ({
        sentBy: label,
        ...msg,
      })),
      markOutbound: vi.fn(),
    },
    configHash: 'hash',
    agentId: 'main',
  };
}

test('logs one first-connect timeline per driver without account details', async () => {
  const { ChannelManager } = await import(REGISTRY_PATH);
  const info = vi.fn<(line: string) => void>();
  const manager = new ChannelManager({ ctx: { logger: { info } } });
  const desired = [
    { platform: 'wecom', instanceId: 'private-account', config: { webhookUrl: 'https://private.invalid/secret' } },
    { platform: 'weixin', instanceId: 'private-login', config: {} },
  ];
  const result = await manager.syncInstances(desired);
  expect(result.errors).toHaveLength(1);
  const driver = manager.instances.get('wecom:private-account').driver;
  driver.markInbound();
  driver.setState('reconnecting');
  driver.setState('connected');
  await manager.syncInstances(desired);
  const retry = manager.instances.get('weixin:private-login').driver;
  retry.setState('error', 'private error details');
  retry.setState('connected');
  await manager.syncInstances([]);

  const lines = info.mock.calls.map(([line]) => line);
  for (const line of lines) {
    expect(line).toMatch(/^\[DshStartup\] pid=\d+ platform=(wecom|weixin) attempt=\d+ stage=(connecting|connected|error) elapsedMs=\d+$/);
  }
  const stages = (platform: string) => lines.filter(line => line.includes(`platform=${platform} `))
    .map(line => line.match(/stage=(\w+)/)?.[1]);
  expect(stages('wecom')).toEqual(['connecting', 'connected']);
  expect(stages('weixin')).toEqual(['connecting', 'error', 'connected']);
  expect(new Set(lines.map(line => line.match(/attempt=(\d+)/)?.[1])).size).toBe(2);
});

describe('DSH ChannelManager multi-instance prefix resolution', () => {
  test('matches exact key, unique 8-char UUID prefix, and sole running instance fallback', async () => {
    const { ChannelManager, resolveChannelInstanceEntry } = await import(REGISTRY_PATH);
    const manager = new ChannelManager({ ctx: {} });

    const feishuAlpha = makeFakeEntry('feishu-alpha');
    const feishuBeta = makeFakeEntry('feishu-beta');
    const weixinSolo = makeFakeEntry('weixin-solo');

    manager.instances.set('feishu:a1b2c3d4-1111-4222-8333-444455556666', feishuAlpha);
    manager.instances.set('feishu:deadbeef-9999-4888-8777-666655554444', feishuBeta);
    manager.instances.set('weixin:wx-account-999', weixinSolo);

    // 1. Exact full UUID match
    const exactRes = await manager.send({
      platform: 'feishu',
      instanceId: 'a1b2c3d4-1111-4222-8333-444455556666',
      chatId: 'oc_1',
      text: 'exact',
    });
    expect(exactRes).toEqual({ sentBy: 'feishu-alpha', chatId: 'oc_1', text: 'exact' });

    // 2. 8-char UUID prefix stored in scheduled task delivery.accountId
    const prefixRes = await manager.send({
      platform: 'feishu',
      instanceId: 'deadbeef',
      chatId: 'oc_2',
      text: 'prefix',
    });
    expect(prefixRes).toEqual({ sentBy: 'feishu-beta', chatId: 'oc_2', text: 'prefix' });
    expect(feishuBeta.driver.markOutbound).toHaveBeenCalledTimes(1);

    // 3. Case-insensitive prefix fallback
    expect(resolveChannelInstanceEntry(manager.instances, 'FEISHU', 'A1B2C3D4')).toBe(feishuAlpha);

    // 4. Omitted / legacy default instanceId resolves sole running instance of platform
    const soloRes = await manager.send({
      platform: 'weixin',
      chatId: 'wxid_1',
      text: 'solo',
    });
    expect(soloRes).toEqual({ sentBy: 'weixin-solo', chatId: 'wxid_1', text: 'solo' });

    // 5. Explicit non-matching prefix must fail rather than routing to wrong bot
    await expect(
      manager.send({
        platform: 'feishu',
        instanceId: 'ffffffff',
        chatId: 'oc_3',
        text: 'nope',
      }),
    ).rejects.toThrow(/is not running/);

    // 6. Omitted instanceId with multiple running instances must fail clearly
    await expect(
      manager.send({
        platform: 'feishu',
        chatId: 'oc_4',
        text: 'ambiguous default',
      }),
    ).rejects.toThrow(/2 instances exist/);

    // 7. Ambiguous prefix shared by two running instances must fail clearly
    const feishuAlphaClone = makeFakeEntry('feishu-alpha-2');
    manager.instances.set('feishu:a1b2c3d4-2222-4222-8333-444455556666', feishuAlphaClone);
    await expect(
      manager.send({
        platform: 'feishu',
        instanceId: 'a1b2c3d4',
        chatId: 'oc_5',
        text: 'ambiguous prefix',
      }),
    ).rejects.toThrow(/ambiguous/);
  });
});
