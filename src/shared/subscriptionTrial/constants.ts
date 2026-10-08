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
}

export interface SubscriptionTrialBridge {
  status: () => Promise<SubscriptionTrialState | null>;
}
