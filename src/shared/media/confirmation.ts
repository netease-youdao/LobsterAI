/** Local confirmation protocol. Analytics reuse existing Hive columns. */
export const MediaConfirmationPolicy = {
  Kind: 'video_generation',
  ReviewMs: 120_000,
  RetentionMs: 30 * 60_000,
} as const;

export const MediaConfirmationStatus = {
  Waiting: 'waiting',
  Visible: 'visible',
  Expired: 'expired',
  Refreshing: 'refreshing',
} as const;
export type MediaConfirmationStatus =
  (typeof MediaConfirmationStatus)[keyof typeof MediaConfirmationStatus];

export const MediaConfirmationAction = {
  Shown: 'shown',
  Renew: 'renew',
  Respond: 'respond',
} as const;
export type MediaConfirmationAction =
  (typeof MediaConfirmationAction)[keyof typeof MediaConfirmationAction];

export const MediaConfirmationReason = {
  UserCancelled: 'user_cancelled',
  Expired: 'confirmation_expired',
  Timeout: 'confirmation_timeout',
  NotDisplayed: 'confirmation_not_displayed',
  NoRoute: 'confirmation_no_route',
  AccountChanged: 'confirmation_account_changed',
  Interrupted: 'confirmation_interrupted',
  InvalidAnswer: 'confirmation_invalid_answer',
  Skipped: 'confirmation_skipped',
  RefreshFailed: 'confirmation_refresh_failed',
} as const;
export type MediaConfirmationReason =
  (typeof MediaConfirmationReason)[keyof typeof MediaConfirmationReason];

export const MediaConfirmationOutcome = {
  Requested: 'requested',
  Shown: 'shown',
  Expired: 'expired',
  Renewed: 'renewed',
  RefreshFailed: 'refresh_failed',
  Allowed: 'allowed',
  Denied: 'denied',
  Timeout: 'timeout',
  Failed: 'failed',
  Interrupted: 'interrupted',
} as const;
export type MediaConfirmationOutcome =
  (typeof MediaConfirmationOutcome)[keyof typeof MediaConfirmationOutcome];

export const ConfirmationBehavior = { Allow: 'allow', Deny: 'deny' } as const;

export interface MediaConfirmationState {
  kind: typeof MediaConfirmationPolicy.Kind;
  revision: number;
  sequence: number;
  status: MediaConfirmationStatus;
  expiresAt?: number;
  retainedUntil: number;
}

export interface MediaConfirmationResponse {
  behavior: 'allow' | 'deny';
  answers?: Record<string, string>;
  skippedQuestionIds?: string[];
  reason?: MediaConfirmationReason;
}

export interface MediaConfirmationCommand {
  requestId: string;
  revision: number;
  action: MediaConfirmationAction;
  response?: MediaConfirmationResponse;
}

export interface MediaConfirmationEvent {
  outcome: MediaConfirmationOutcome;
  failureCode?: MediaConfirmationReason;
  durationMs: number;
  count: number;
}

export const readMediaConfirmationState = (value: unknown): MediaConfirmationState | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as MediaConfirmationState;
  return item.kind === MediaConfirmationPolicy.Kind &&
    Number.isInteger(item.revision) &&
    item.revision >= 0 &&
    Number.isInteger(item.sequence) &&
    item.sequence >= 0 &&
    Object.values(MediaConfirmationStatus).includes(item.status) &&
    Number.isFinite(item.retainedUntil) &&
    (item.expiresAt === undefined || Number.isFinite(item.expiresAt))
    ? item
    : undefined;
};
