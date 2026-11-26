import { describe, expect, test, vi } from 'vitest';

import { DshChannelState, RetainedImPlatform } from '../../shared/dshEngine/hostConstants';
import { t } from '../i18n';
import { DEFAULT_IM_CONFIG, DEFAULT_WECOM_CONFIG } from './types';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => '/private/tmp' } }));
vi.mock('./imStore', () => ({ IMStore: class {} }));

import { type DshChannelsBridgePort, IMGatewayManager } from './imGatewayManager';

function setup() {
  const bridge: DshChannelsBridgePort = {
    isReady: vi.fn(() => true),
    listStatus: vi.fn(async () => ({
      supportedPlatforms: [RetainedImPlatform.WeCom],
      statuses: [
        {
          platform: RetainedImPlatform.WeCom,
          instanceId: 'online',
          state: DshChannelState.Connected,
          error: null,
          startedAt: 1000,
          lastInboundAt: 2000,
          lastOutboundAt: 3000,
        },
        {
          platform: RetainedImPlatform.WeCom,
          instanceId: 'failing',
          state: DshChannelState.Error,
          error: 'WeCom AI Bot WebSocket connection failed',
        },
        {
          platform: RetainedImPlatform.WeCom,
          instanceId: 'disabled',
          state: DshChannelState.Connected,
          error: null,
        },
        {
          platform: RetainedImPlatform.DingTalk,
          instanceId: 'unseen',
          state: DshChannelState.Connected,
          error: null,
        },
      ],
    })),
    weixinQrStart: vi.fn(),
    weixinQrPoll: vi.fn(),
  };
  const manager = new IMGatewayManager({} as never, { getDshChannelsBridge: () => bridge });
  vi.spyOn(manager, 'getConfig').mockReturnValue({
    ...DEFAULT_IM_CONFIG,
    wecom: {
      instances: ['online', 'failing', 'disabled', 'unseen'].map(instanceId => ({
        ...DEFAULT_WECOM_CONFIG,
        instanceId,
        instanceName: instanceId,
        enabled: instanceId !== 'disabled',
        botId: instanceId,
        secret: 'test-secret',
      })),
    },
  });
  return { bridge, manager };
}

describe('IMGatewayManager WeCom DSH connection status', () => {
  test('keeps a legacy duplicate tied to its saved owner even with stale runtime status', () => {
    const { manager } = setup();
    const config = manager.getConfig();
    config.wecom.instances[1].botId = config.wecom.instances[0].botId;
    const statuses = manager.getStatus(new Map([
      ['online', { platform: RetainedImPlatform.WeCom, instanceId: 'online', state: DshChannelState.Error, error: 'imWecomConnectionReplaced' }],
      ['failing', { platform: RetainedImPlatform.WeCom, instanceId: 'failing', state: DshChannelState.Connected }],
    ])).wecom.instances;
    expect(statuses[0]).toMatchObject({ connected: false, lastError: t('imWecomConnectionReplaced') });
    expect(statuses[1]).toMatchObject({ connected: false, lastError: t('imWecomDuplicateBot', { name: 'online' }) });
  });

  test('projects live state, error and activity for the matching enabled instance', async () => {
    const { manager } = setup();

    expect((await manager.getStatusWithOpenClawRuntime()).wecom.instances).toMatchObject([
      { instanceId: 'online', connected: true, lastError: null, startedAt: 1000, lastInboundAt: 2000, lastOutboundAt: 3000 },
      { instanceId: 'failing', connected: false, lastError: 'WeCom AI Bot WebSocket connection failed', startedAt: null },
      { instanceId: 'disabled', connected: false, lastError: null },
      { instanceId: 'unseen', connected: false, lastError: null },
    ]);
  });

  test('keeps saved credentials disconnected when no runtime status is available', async () => {
    const { bridge, manager } = setup();
    vi.mocked(bridge.listStatus).mockRejectedValueOnce(new Error('runtime unreachable'));
    vi.mocked(bridge.isReady).mockReturnValueOnce(false);

    expect(manager.getStatus().wecom.instances.map(instance => instance.connected)).toEqual([false, false, false, false]);
    expect((await manager.getStatusWithOpenClawRuntime()).wecom.instances.every(instance => !instance.connected)).toBe(true);
    expect((await manager.getStatusWithOpenClawRuntime()).wecom.instances.every(instance => !instance.connected)).toBe(true);
    expect(bridge.listStatus).toHaveBeenCalledTimes(1);
  });
});
