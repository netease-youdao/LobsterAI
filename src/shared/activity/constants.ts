export const ActivityContainerApiVersion = {
  NativeDailyCheckInV1: 2,
  NativeStartupCreditV1: 3,
} as const;

export type ActivityContainerApiVersion =
  typeof ActivityContainerApiVersion[keyof typeof ActivityContainerApiVersion];

export const ActivityPlacement = {
  DesktopSidebar: 'desktop_sidebar',
  DesktopStartupModal: 'desktop_startup_modal',
} as const;

export type ActivityPlacement = typeof ActivityPlacement[keyof typeof ActivityPlacement];

export const ActivityType = {
  DailyCheckIn: 'daily_check_in',
  OneTimeCreditReward: 'one_time_credit_reward',
} as const;

export type ActivityType = typeof ActivityType[keyof typeof ActivityType];

export const ActivityTemplate = {
  NativeDailyCheckInV1: 'native_daily_check_in_v1',
  NativeStartupCreditV1: 'native_startup_credit_v1',
} as const;

export type ActivityTemplate = typeof ActivityTemplate[keyof typeof ActivityTemplate];

export const ActivitySlotState = {
  Empty: 'empty',
  Available: 'available',
} as const;

export type ActivitySlotState = typeof ActivitySlotState[keyof typeof ActivitySlotState];

export const ActivityLifecycleState = {
  Active: 'active',
  NotStarted: 'not_started',
  Ended: 'ended',
  Offline: 'offline',
  Superseded: 'superseded',
} as const;

export type ActivityLifecycleState =
  typeof ActivityLifecycleState[keyof typeof ActivityLifecycleState];

export const DailyCheckInAction = {
  CheckIn: 'check_in',
} as const;

export type DailyCheckInAction =
  typeof DailyCheckInAction[keyof typeof DailyCheckInAction];

export const OneTimeCreditAction = {
  Claim: 'claim',
} as const;

export type OneTimeCreditAction =
  typeof OneTimeCreditAction[keyof typeof OneTimeCreditAction];

export type ActivityAction = DailyCheckInAction | OneTimeCreditAction;

export const ActivityServerErrorCode = {
  NotFound: 51100,
  NotActive: 51101,
  LoginRequired: 51102,
  ActionInvalid: 51103,
  AlreadyClaimed: 51104,
  ConfigInvalid: 51105,
  RevisionMismatch: 51106,
} as const;

export type ActivityServerErrorCode =
  typeof ActivityServerErrorCode[keyof typeof ActivityServerErrorCode];

export const ActivityIpc = {
  HostGetSlot: 'activity:host:get-slot',
  HostGetContext: 'activity:host:get-context',
  HostExecuteAction: 'activity:host:execute-action',
} as const;

export type ActivityIpc = typeof ActivityIpc[keyof typeof ActivityIpc];

interface ActivityDescriptorBase {
  activityCode: string;
  configRevision: number;
  activityType: ActivityType;
  placement: ActivityPlacement;
  templateKey: ActivityTemplate;
  startAt: string;
  endAt: string;
  timezone: string;
  loginRequired: boolean;
  periodLabel: string;
  cardTitle: string;
}

export interface DailyCheckInDescriptor extends ActivityDescriptorBase {
  activityType: typeof ActivityType.DailyCheckIn;
  placement: typeof ActivityPlacement.DesktopSidebar;
  templateKey: typeof ActivityTemplate.NativeDailyCheckInV1;
  guestModalTitle: string;
  guestModalDescription: string;
  guestModalActionText: string;
}

export interface StartupCreditDescriptor extends ActivityDescriptorBase {
  activityType: typeof ActivityType.OneTimeCreditReward;
  placement: typeof ActivityPlacement.DesktopStartupModal;
  templateKey: typeof ActivityTemplate.NativeStartupCreditV1;
  modalTitle: string;
  modalDescription: string;
  actionText: string;
  posterUrl: string;
  posterAlt: string;
  autoPopupStartAt: string;
  autoPopupEndAt: string;
}

export type ActivityDescriptor = DailyCheckInDescriptor | StartupCreditDescriptor;

export interface ActivitySlotResponse {
  slotState: ActivitySlotState;
  serverTime: string;
  activity?: ActivityDescriptor;
}

export interface DailyCheckInState {
  totalDays: number;
  claimedDays: number;
  remainingDays: number;
  claimedToday: boolean;
  completed: boolean;
  rewardCredits: number;
  claimedCredits: number;
  timezone: string;
}

export interface OneTimeCreditState {
  claimed: boolean;
  claimable: boolean;
  rewardCredits: number;
  rewardValidityDays: number;
  claimedAt?: string | null;
  expiresAt?: string | null;
}

export type ActivityState = DailyCheckInState | OneTimeCreditState;

export interface ActivityContextResponse<
  TState extends ActivityState = ActivityState,
  TAction extends ActivityAction = ActivityAction,
> {
  activityCode: string;
  configRevision: number;
  lifecycleState: ActivityLifecycleState;
  authenticated: boolean;
  loginRequired: boolean;
  serverTime: string;
  state: TState;
  actions: TAction[];
}

export type DailyCheckInContextResponse =
  ActivityContextResponse<DailyCheckInState, DailyCheckInAction>;

export type StartupCreditContextResponse =
  ActivityContextResponse<OneTimeCreditState, OneTimeCreditAction>;

export interface DailyCheckInActionResult {
  activityCode: string;
  actionId: DailyCheckInAction;
  periodKey: string;
  creditsGranted: number;
  claimedAt: string;
  expiresAt: string;
  claimedDays: number;
  totalDays: number;
}

export interface OneTimeCreditActionResult {
  activityCode: string;
  actionId: OneTimeCreditAction;
  periodKey: string;
  creditsGranted: number;
  claimedAt: string;
  expiresAt: string;
}

export type ActivityActionResult =
  DailyCheckInActionResult | OneTimeCreditActionResult;

export interface ActivityActionResponse<
  TResult extends ActivityActionResult = ActivityActionResult,
  TContext extends ActivityContextResponse = ActivityContextResponse,
> {
  replayed: boolean;
  result: TResult;
  context: TContext;
}

export type DailyCheckInActionResponse = ActivityActionResponse<
  DailyCheckInActionResult,
  DailyCheckInContextResponse
>;

export type StartupCreditActionResponse = ActivityActionResponse<
  OneTimeCreditActionResult,
  StartupCreditContextResponse
>;

export type ActivityResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: number; httpStatus?: number };

export interface ActivityHostGetSlotInput {
  placement: ActivityPlacement;
}

export interface ActivityHostGetContextInput {
  placement: ActivityPlacement;
  activityCode: string;
  configRevision: number;
}

export interface ActivityHostExecuteActionInput extends ActivityHostGetContextInput {
  actionId: ActivityAction;
  idempotencyKey: string;
}
