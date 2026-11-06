export const SubscriptionTrialIpc = {
  Status: 'subscription-trial:status',
} as const;

export const SubscriptionTrialApi = {
  Status: '/api/subscription-trial',
} as const;

export interface SubscriptionTrialState {
  campaignCode: string;
  active: boolean;
  visible: boolean;
  eligible: boolean;
  reason?: string;
  serverTimeEpochMs: number;
  endAtEpochMs: number | null;
  /** Older servers omit this field; treat a missing value as hidden. */
  clientMenuEntryVisible?: boolean;
  firstRenewalPrice?: number;
  firstRenewalDiscountEnabled?: boolean;
}

export interface SubscriptionTrialBridge {
  status: () => Promise<SubscriptionTrialState | null>;
}
