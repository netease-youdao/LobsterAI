import { type ConfigDeliveryReceipt,ConfigDeliveryState } from '../../shared/openclawEngine/configDelivery';

/** A receipt proves application in its owner process only, never in a replacement. */
export function guardConfigReceiptGeneration(
  receipt: ConfigDeliveryReceipt,
  currentGeneration: number,
  shuttingDown = false,
): ConfigDeliveryReceipt {
  if (receipt.state !== ConfigDeliveryState.Applied
    || (!shuttingDown && receipt.gatewayGeneration === currentGeneration)) return receipt;
  return { ...receipt, state: ConfigDeliveryState.Pending, appliedRevision: undefined };
}
