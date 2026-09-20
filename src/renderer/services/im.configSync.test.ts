import { afterEach, expect, test, vi } from 'vitest';

import { ConfigDeliveryState } from '../../shared/openclawEngine/configDelivery';

vi.mock('../store', () => ({ store: { dispatch: vi.fn() } }));
vi.mock('./logReporter', () => ({ LogReporterAction: {}, reportYdAnalyzer: vi.fn() }));
import { imService } from './im';

afterEach(() => vi.unstubAllGlobals());

test.each([ConfigDeliveryState.Applied, ConfigDeliveryState.Pending, ConfigDeliveryState.RestartRequired, ConfigDeliveryState.Rejected])(
  'IM renderer bridge preserves %s delivery state and revision evidence', async deliveryState => {
    const receipt = { success: deliveryState !== ConfigDeliveryState.Rejected,
      applied: deliveryState === ConfigDeliveryState.Applied, deliveryState,
      mutationId: 'mutation', desiredRevision: 'desired', persistedRevision: 'persisted', appliedRevision: 'applied', gatewayGeneration: 4 };
    const syncConfig = vi.fn().mockResolvedValue(receipt);
    vi.stubGlobal('window', { electron: { im: { syncConfig } } });
    expect(await imService.saveAndSyncConfig()).toEqual(receipt);
    expect(syncConfig).toHaveBeenCalledOnce();
  },
);

test('an IPC exception remains a diagnosable rejection', async () => {
  vi.stubGlobal('window', { electron: { im: { syncConfig: vi.fn().mockRejectedValue(new Error('IPC unavailable')) } } });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(imService.saveAndSyncConfig()).resolves.toEqual({
      success: false, deliveryState: ConfigDeliveryState.Rejected, error: 'IPC unavailable',
    });
  } finally { log.mockRestore(); }
});
