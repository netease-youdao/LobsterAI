export const ConfigDeliveryState = {
  Applied: 'applied', Pending: 'pending', Rejected: 'rejected', RestartRequired: 'restart-required',
} as const;
export type ConfigDeliveryState = typeof ConfigDeliveryState[keyof typeof ConfigDeliveryState];

/** Public receipt contains identities only, never raw configuration or secrets. */
export interface ConfigDeliveryReceipt {
  state: ConfigDeliveryState;
  mutationId?: string;
  desiredRevision?: string;
  persistedRevision?: string;
  appliedRevision?: string;
  gatewayGeneration?: number;
}
