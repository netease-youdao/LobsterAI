import {
  type ActivityContextResponse,
  ActivityLifecycleState,
  ActivityPlacement,
  ActivityTemplate,
  ActivityType,
  DailyCheckInAction,
  type DailyCheckInContextResponse,
  type DailyCheckInDescriptor,
  type DailyCheckInState,
} from '../../shared/activity/constants';

const ACTIVITY_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;

const isFiniteNonNegative = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === 'string' && value.trim().length > 0
);

export const getDailyCheckInAuthScopeKey = (
  ownerAccountKey: string | null,
  accountGeneration: number,
): string => `${ownerAccountKey ?? 'anonymous'}:${accountGeneration}`;

export function isDailyCheckInDescriptor(
  value: unknown,
): value is DailyCheckInDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptor = value as Partial<DailyCheckInDescriptor>;
  return typeof descriptor.activityCode === 'string'
    && ACTIVITY_CODE_PATTERN.test(descriptor.activityCode)
    && Number.isInteger(descriptor.configRevision)
    && (descriptor.configRevision ?? 0) > 0
    && isNonEmptyString(descriptor.startAt)
    && isNonEmptyString(descriptor.endAt)
    && isNonEmptyString(descriptor.timezone)
    && typeof descriptor.loginRequired === 'boolean'
    && descriptor.activityType === ActivityType.DailyCheckIn
    && descriptor.placement === ActivityPlacement.DesktopSidebar
    && descriptor.templateKey === ActivityTemplate.NativeDailyCheckInV1
    && typeof descriptor.periodLabel === 'string'
    && typeof descriptor.cardTitle === 'string'
    && typeof descriptor.guestModalTitle === 'string'
    && typeof descriptor.guestModalDescription === 'string'
    && typeof descriptor.guestModalActionText === 'string';
}

export function isDailyCheckInState(value: unknown): value is DailyCheckInState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<DailyCheckInState>;
  return Number.isInteger(state.totalDays)
    && (state.totalDays ?? 0) > 0
    && Number.isInteger(state.claimedDays)
    && (state.claimedDays ?? -1) >= 0
    && (state.claimedDays ?? Number.POSITIVE_INFINITY) <= (state.totalDays ?? -1)
    && Number.isInteger(state.remainingDays)
    && (state.remainingDays ?? -1) >= 0
    && (state.remainingDays ?? Number.POSITIVE_INFINITY) <= (state.totalDays ?? -1)
    && typeof state.claimedToday === 'boolean'
    && typeof state.completed === 'boolean'
    && isFiniteNonNegative(state.rewardCredits)
    && state.rewardCredits > 0
    && isFiniteNonNegative(state.claimedCredits)
    && typeof state.timezone === 'string'
    && state.timezone.trim().length > 0;
}

export function isDailyCheckInContext(
  value: unknown,
): value is DailyCheckInContextResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Partial<ActivityContextResponse>;
  return typeof context.activityCode === 'string'
    && ACTIVITY_CODE_PATTERN.test(context.activityCode)
    && Number.isInteger(context.configRevision)
    && (context.configRevision ?? 0) > 0
    && Object.values(ActivityLifecycleState).includes(
      context.lifecycleState as ActivityLifecycleState,
    )
    && typeof context.authenticated === 'boolean'
    && typeof context.loginRequired === 'boolean'
    && isNonEmptyString(context.serverTime)
    && isDailyCheckInState(context.state)
    && Array.isArray(context.actions)
    && context.actions.every(action => action === DailyCheckInAction.CheckIn);
}

export function isActiveDailyCheckInContext(
  value: unknown,
): value is DailyCheckInContextResponse {
  return isDailyCheckInContext(value)
    && value.lifecycleState === ActivityLifecycleState.Active;
}

export function canClaimDailyCheckIn(context: ActivityContextResponse): boolean {
  return isActiveDailyCheckInContext(context)
    && context.authenticated
    && !context.state.claimedToday
    && !context.state.completed
    && context.actions.includes(DailyCheckInAction.CheckIn);
}

export function shouldShowDailyCheckInEntry(
  context: ActivityContextResponse,
): boolean {
  return isActiveDailyCheckInContext(context)
    && !context.state.claimedToday
    && !context.state.completed;
}

export function shouldShowDailyCheckInAccountMenuEntry(
  context: ActivityContextResponse,
): boolean {
  return isActiveDailyCheckInContext(context)
    && !context.state.completed;
}

export function formatDailyCheckInCredits(value: number): string {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}
