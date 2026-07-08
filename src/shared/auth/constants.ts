export const AuthIpcChannel = {
  Callback: 'auth:callback',
  GetPricingCatalog: 'auth:getPricingCatalog',
  GetPendingCallback: 'auth:getPendingCallback',
} as const;

export type AuthIpcChannel = typeof AuthIpcChannel[keyof typeof AuthIpcChannel];

export const AuthSubscriptionStatus = {
  Active: 'active',
  Free: 'free',
} as const;

export type AuthSubscriptionStatus = typeof AuthSubscriptionStatus[keyof typeof AuthSubscriptionStatus];
