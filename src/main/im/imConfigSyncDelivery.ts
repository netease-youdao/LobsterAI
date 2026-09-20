import type { IMConfigSyncResult } from '../../shared/im/configSync';
import { ConfigDeliveryState } from '../../shared/openclawEngine/configDelivery';

type SyncResult = Omit<IMConfigSyncResult, 'pending' | 'applied' | 'skipped'>;
type SyncOptions = { reason: string; imConfigRestartFingerprint: string };

/** IM edits are live configuration. QR login owns its channel credential reload. */
export async function syncIMConfigDelivery(
  sync: (options: SyncOptions) => Promise<SyncResult>,
  fingerprint: string,
): Promise<IMConfigSyncResult> {
  const result = await sync({ reason: 'im-config-change', imConfigRestartFingerprint: fingerprint });
  const deliveryState = result.deliveryState
    ?? (result.success ? ConfigDeliveryState.Pending : ConfigDeliveryState.Rejected);
  const applied = result.success && deliveryState === ConfigDeliveryState.Applied;
  const pending = deliveryState === ConfigDeliveryState.Pending
    || deliveryState === ConfigDeliveryState.RestartRequired;
  return {
    success: applied || pending,
    applied,
    pending,
    deliveryState,
    mutationId: result.mutationId,
    desiredRevision: result.desiredRevision,
    persistedRevision: result.persistedRevision,
    appliedRevision: result.appliedRevision,
    gatewayGeneration: result.gatewayGeneration,
    ...(result.error ? { error: result.error } : {}),
  };
}
