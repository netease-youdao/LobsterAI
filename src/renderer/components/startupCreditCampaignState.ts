import {
  type ActivityContextResponse,
  ActivityLifecycleState,
  ActivityPlacement,
  ActivityTemplate,
  ActivityType,
  OneTimeCreditAction,
  type OneTimeCreditState,
  type StartupCreditContextResponse,
  type StartupCreditDescriptor,
} from '@shared/activity/constants';

const ACTIVITY_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const STARTUP_DISMISS_KEY_PREFIX = 'startup_credit_campaign.auto_dismissed.v1';
const STARTUP_PENDING_CLAIM_KEY = 'startup_credit_campaign.pending_claim.v1';
const STARTUP_POSTER_REVISION_QUERY_PARAM = 'lobster_activity_revision';

export const STARTUP_PENDING_CLAIM_TTL_MS = 30 * 60 * 1000;

export interface StartupCreditSnapshot {
  descriptor: StartupCreditDescriptor;
  context: StartupCreditContextResponse;
}

export interface PendingStartupCreditClaim {
  version: 1;
  activityCode: string;
  configRevision: number;
  idempotencyKey: string;
  createdAt: number;
  expiresAt: number;
}

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);

const isPositiveFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

const isValidDateTime = (value: unknown): value is string => (
  isNonEmptyString(value) && Number.isFinite(Date.parse(value))
);

export function isStartupCreditDescriptor(
  value: unknown,
): value is StartupCreditDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptor = value as Partial<StartupCreditDescriptor>;
  return isNonEmptyString(descriptor.activityCode)
    && ACTIVITY_CODE_PATTERN.test(descriptor.activityCode)
    && Number.isInteger(descriptor.configRevision)
    && (descriptor.configRevision ?? 0) > 0
    && descriptor.activityType === ActivityType.OneTimeCreditReward
    && descriptor.placement === ActivityPlacement.DesktopStartupModal
    && descriptor.templateKey === ActivityTemplate.NativeStartupCreditV1
    && isValidDateTime(descriptor.startAt)
    && isValidDateTime(descriptor.endAt)
    && isNonEmptyString(descriptor.timezone)
    && typeof descriptor.loginRequired === 'boolean'
    && isNonEmptyString(descriptor.periodLabel)
    && isNonEmptyString(descriptor.cardTitle)
    && isNonEmptyString(descriptor.modalTitle)
    && isNonEmptyString(descriptor.modalDescription)
    && isNonEmptyString(descriptor.actionText)
    && isNonEmptyString(descriptor.posterUrl)
    && isNonEmptyString(descriptor.posterAlt)
    && isValidDateTime(descriptor.autoPopupStartAt)
    && isValidDateTime(descriptor.autoPopupEndAt)
    && Date.parse(descriptor.startAt) <= Date.parse(descriptor.autoPopupStartAt)
    && Date.parse(descriptor.autoPopupStartAt) < Date.parse(descriptor.autoPopupEndAt)
    && Date.parse(descriptor.autoPopupEndAt) <= Date.parse(descriptor.endAt);
}

export function isStartupCreditAutoPopupActive(
  descriptor: StartupCreditDescriptor,
  now = Date.now(),
): boolean {
  const startAt = Date.parse(descriptor.autoPopupStartAt);
  const endAt = Date.parse(descriptor.autoPopupEndAt);
  return Number.isFinite(startAt)
    && Number.isFinite(endAt)
    && now >= startAt
    && now < endAt;
}

export function isOneTimeCreditState(
  value: unknown,
): value is OneTimeCreditState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<OneTimeCreditState>;
  return typeof state.claimed === 'boolean'
    && typeof state.claimable === 'boolean'
    && state.claimable === !state.claimed
    && isPositiveFiniteNumber(state.rewardCredits)
    && Number.isInteger(state.rewardValidityDays)
    && (state.rewardValidityDays ?? 0) > 0
    && (state.claimedAt === undefined
      || state.claimedAt === null
      || isNonEmptyString(state.claimedAt))
    && (state.expiresAt === undefined
      || state.expiresAt === null
      || isNonEmptyString(state.expiresAt));
}

export function isStartupCreditContext(
  value: unknown,
): value is StartupCreditContextResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Partial<ActivityContextResponse>;
  return isNonEmptyString(context.activityCode)
    && ACTIVITY_CODE_PATTERN.test(context.activityCode)
    && Number.isInteger(context.configRevision)
    && (context.configRevision ?? 0) > 0
    && Object.values(ActivityLifecycleState).includes(
      context.lifecycleState as ActivityLifecycleState,
    )
    && typeof context.authenticated === 'boolean'
    && typeof context.loginRequired === 'boolean'
    && isNonEmptyString(context.serverTime)
    && isOneTimeCreditState(context.state)
    && Array.isArray(context.actions)
    && context.actions.every(action => action === OneTimeCreditAction.Claim);
}

export function isActiveStartupCreditContext(
  value: unknown,
): value is StartupCreditContextResponse {
  return isStartupCreditContext(value)
    && value.lifecycleState === ActivityLifecycleState.Active;
}

export function canClaimStartupCredit(
  context: StartupCreditContextResponse,
): boolean {
  return context.lifecycleState === ActivityLifecycleState.Active
    && context.authenticated
    && !context.state.claimed
    && context.state.claimable
    && context.actions.includes(OneTimeCreditAction.Claim);
}

export function getStartupCreditDismissKey(activityCode: string): string {
  return `${STARTUP_DISMISS_KEY_PREFIX}.${activityCode}`;
}

export function buildStartupCreditPosterUrl(
  posterUrl: string,
  configRevision: number,
): string {
  try {
    const url = new URL(posterUrl);
    url.searchParams.set(
      STARTUP_POSTER_REVISION_QUERY_PARAM,
      String(configRevision),
    );
    return url.toString();
  } catch {
    return posterUrl;
  }
}

export function isStartupCreditAutoDismissed(
  storage: Pick<Storage, 'getItem'>,
  activityCode: string,
): boolean {
  try {
    return storage.getItem(getStartupCreditDismissKey(activityCode)) === '1';
  } catch {
    return false;
  }
}

export function dismissStartupCreditAutoPopup(
  storage: Pick<Storage, 'setItem'>,
  activityCode: string,
): void {
  try {
    storage.setItem(getStartupCreditDismissKey(activityCode), '1');
  } catch {
    // The in-memory modal state still closes if browser storage is unavailable.
  }
}

export function createStartupCreditIdempotencyKey(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `startup-credit-${suffix}`.slice(0, 64);
}

export function writePendingStartupCreditClaim(
  storage: Pick<Storage, 'setItem'>,
  binding: Pick<StartupCreditDescriptor, 'activityCode' | 'configRevision'>,
  now = Date.now(),
  idempotencyKey = createStartupCreditIdempotencyKey(),
): PendingStartupCreditClaim {
  const pending: PendingStartupCreditClaim = {
    version: 1,
    activityCode: binding.activityCode,
    configRevision: binding.configRevision,
    idempotencyKey,
    createdAt: now,
    expiresAt: now + STARTUP_PENDING_CLAIM_TTL_MS,
  };
  try {
    storage.setItem(STARTUP_PENDING_CLAIM_KEY, JSON.stringify(pending));
  } catch {
    // The current renderer can still finish the claim with the returned key.
  }
  return pending;
}

export function readPendingStartupCreditClaim(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  now = Date.now(),
): PendingStartupCreditClaim | null {
  let raw: string | null;
  try {
    raw = storage.getItem(STARTUP_PENDING_CLAIM_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingStartupCreditClaim>;
    const valid = value.version === 1
      && isNonEmptyString(value.activityCode)
      && ACTIVITY_CODE_PATTERN.test(value.activityCode)
      && Number.isInteger(value.configRevision)
      && (value.configRevision ?? 0) > 0
      && isNonEmptyString(value.idempotencyKey)
      && IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)
      && typeof value.createdAt === 'number'
      && Number.isFinite(value.createdAt)
      && typeof value.expiresAt === 'number'
      && Number.isFinite(value.expiresAt)
      && value.expiresAt > now;
    if (valid) return value as PendingStartupCreditClaim;
  } catch {
    // Invalid or old state is removed below.
  }
  clearPendingStartupCreditClaim(storage);
  return null;
}

export function clearPendingStartupCreditClaim(
  storage: Pick<Storage, 'removeItem'>,
): void {
  try {
    storage.removeItem(STARTUP_PENDING_CLAIM_KEY);
  } catch {
    // Nothing else can be done if browser storage is unavailable.
  }
}

export function formatStartupCreditAmount(value: number): string {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}
