import { type ConfigDeliveryReceipt,ConfigDeliveryState } from '../openclawEngine/configDelivery';

/** success means the saved request was accepted; only applied confirms runtime use. */
export interface IMConfigSyncResult extends Partial<Omit<ConfigDeliveryReceipt, 'state'>> {
  success: boolean;
  applied?: boolean;
  pending?: boolean;
  skipped?: boolean;
  deliveryState?: ConfigDeliveryState;
  error?: string;
}

export const IMConfigSaveStatus = {
  Saved: 'saved', Pending: 'pending', Rejected: 'rejected',
} as const;

export function getIMConfigSaveStatus(result: IMConfigSyncResult): typeof IMConfigSaveStatus[keyof typeof IMConfigSaveStatus] {
  if (result.deliveryState === ConfigDeliveryState.Rejected) return IMConfigSaveStatus.Rejected;
  if (result.pending || result.deliveryState === ConfigDeliveryState.Pending
    || result.deliveryState === ConfigDeliveryState.RestartRequired) return IMConfigSaveStatus.Pending;
  if (!result.success) return IMConfigSaveStatus.Rejected;
  if (result.skipped || result.deliveryState === ConfigDeliveryState.Applied || result.applied) {
    return IMConfigSaveStatus.Saved;
  }
  return IMConfigSaveStatus.Pending;
}
