import type {
  BrowserWindow,
  IpcMain,
  IpcMainInvokeEvent,
} from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  type ActivityActionResponse,
  type ActivityContextResponse,
  ActivityIpc,
  ActivityLifecycleState,
  ActivityPlacement,
  type ActivityResult,
  ActivitySlotState,
  ActivityTemplate,
  ActivityType,
  DailyCheckInAction,
  OneTimeCreditAction,
} from '../../../shared/activity/constants';
import { registerActivityIpcHandlers } from './handlers';

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  input?: unknown,
) => Promise<ActivityResult<unknown>>;

const apiResponse = (data: unknown): Response => new Response(
  JSON.stringify({ code: 0, message: 'success', data }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

const activityDescriptor = {
  activityCode: 'login-seven-days',
  configRevision: 3,
  activityType: ActivityType.DailyCheckIn,
  placement: ActivityPlacement.DesktopSidebar,
  templateKey: ActivityTemplate.NativeDailyCheckInV1,
  startAt: '2026-07-30T00:00:00Z',
  endAt: '2026-08-06T00:00:00Z',
  timezone: 'Asia/Shanghai',
  loginRequired: true,
  periodLabel: 'Phase 1',
  cardTitle: 'Daily credits',
  guestModalTitle: 'Log in to claim',
  guestModalDescription: 'Claim credits after login',
  guestModalActionText: 'Log in',
};

const activityContext: ActivityContextResponse = {
  activityCode: activityDescriptor.activityCode,
  configRevision: activityDescriptor.configRevision,
  lifecycleState: ActivityLifecycleState.Active,
  authenticated: true,
  loginRequired: true,
  serverTime: '2026-07-30T01:00:00Z',
  state: {
    totalDays: 7,
    claimedDays: 0,
    remainingDays: 7,
    claimedToday: false,
    completed: false,
    rewardCredits: 100,
    claimedCredits: 0,
    timezone: 'Asia/Shanghai',
  },
  actions: [DailyCheckInAction.CheckIn],
};

const startupDescriptor = {
  activityCode: 'netease-user-welcome',
  configRevision: 1,
  activityType: ActivityType.OneTimeCreditReward,
  placement: ActivityPlacement.DesktopStartupModal,
  templateKey: ActivityTemplate.NativeStartupCreditV1,
  startAt: '2026-07-30T00:00:00Z',
  endAt: '2026-08-30T00:00:00Z',
  timezone: 'Asia/Shanghai',
  loginRequired: true,
  periodLabel: 'Limited time',
  cardTitle: 'User reward',
  modalTitle: 'Welcome to LobsterAI',
  modalDescription: 'Log in to claim 5000 credits',
  actionText: 'Claim now',
  posterUrl: 'https://example.com/reward.png',
  posterAlt: 'LobsterAI user reward',
  autoPopupStartAt: '2026-07-30T00:00:00Z',
  autoPopupEndAt: '2026-08-15T00:00:00Z',
};

const startupContext: ActivityContextResponse = {
  activityCode: startupDescriptor.activityCode,
  configRevision: startupDescriptor.configRevision,
  lifecycleState: ActivityLifecycleState.Active,
  authenticated: true,
  loginRequired: true,
  serverTime: '2026-07-30T01:00:00Z',
  state: {
    claimed: false,
    claimable: true,
    rewardCredits: 5000,
    rewardValidityDays: 30,
  },
  actions: [OneTimeCreditAction.Claim],
};

const actionResponse: ActivityActionResponse = {
  replayed: false,
  result: {
    activityCode: activityDescriptor.activityCode,
    actionId: DailyCheckInAction.CheckIn,
    periodKey: '2026-07-30',
    creditsGranted: 100,
    claimedAt: '2026-07-30T01:00:00Z',
    expiresAt: '2026-08-30T01:00:00Z',
    claimedDays: 1,
    totalDays: 7,
  },
  context: {
    ...activityContext,
    state: {
      ...activityContext.state,
      claimedDays: 1,
      remainingDays: 6,
      claimedToday: true,
      claimedCredits: 100,
    },
    actions: [],
  },
};

function createHarness() {
  const handlers = new Map<string, InvokeHandler>();
  const handle = vi.fn((channel: string, listener: InvokeHandler) => {
    handlers.set(channel, listener);
  });
  const mainFrame = {};
  const webContents = { mainFrame };
  const mainWindow = {
    isDestroyed: () => false,
    webContents,
  } as unknown as BrowserWindow;
  const event = {
    sender: webContents,
    senderFrame: mainFrame,
  } as unknown as IpcMainInvokeEvent;
  const fetchPublic = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const fetchWithAuth = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

  registerActivityIpcHandlers({
    ipcMain: { handle } as unknown as IpcMain,
    getMainWindow: () => mainWindow,
    getServerBaseUrl: () => 'https://server.example',
    getClientVersion: () => '2026.7.30',
    platform: 'win32',
    hasAuthTokens: () => true,
    fetchPublic,
    fetchWithAuth,
  });

  return {
    event,
    fetchPublic,
    fetchWithAuth,
    handlers,
    mainFrame,
    webContents,
  };
}

describe('activity IPC handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('uses the requested supported slot and binds context access to its activity', async () => {
    const harness = createHarness();
    harness.fetchWithAuth
      .mockResolvedValueOnce(apiResponse({
        slotState: ActivitySlotState.Available,
        serverTime: '2026-07-30T01:00:00Z',
        activity: activityDescriptor,
      }))
      .mockResolvedValueOnce(apiResponse(activityContext));
    const getSlot = harness.handlers.get(ActivityIpc.HostGetSlot);
    const getContext = harness.handlers.get(ActivityIpc.HostGetContext);

    const slotResult = await getSlot?.(
      harness.event,
      { placement: ActivityPlacement.DesktopSidebar },
    );
    expect(slotResult?.success).toBe(true);
    expect(harness.fetchWithAuth).toHaveBeenNthCalledWith(
      1,
      'https://server.example/api/client-activities/slot'
        + '?placement=desktop_sidebar&clientVersion=2026.7.30'
        + '&containerApiVersion=2&platform=win32',
      expect.objectContaining({ headers: expect.any(Headers) }),
    );

    const rejected = await getContext?.(harness.event, {
      placement: ActivityPlacement.DesktopSidebar,
      activityCode: 'different-activity',
      configRevision: 3,
    });
    expect(rejected).toEqual({
      success: false,
      error: 'Activity binding is no longer available',
    });
    expect(harness.fetchWithAuth).toHaveBeenCalledTimes(1);

    const accepted = await getContext?.(harness.event, {
      placement: ActivityPlacement.DesktopSidebar,
      activityCode: activityDescriptor.activityCode,
      configRevision: activityDescriptor.configRevision,
    });
    expect(accepted).toEqual({ success: true, data: activityContext });
    expect(harness.fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  test('rejects actions that do not match the advertised binding', async () => {
    const harness = createHarness();
    harness.fetchWithAuth
      .mockResolvedValueOnce(apiResponse({
        slotState: ActivitySlotState.Available,
        serverTime: '2026-07-30T01:00:00Z',
        activity: activityDescriptor,
      }))
      .mockResolvedValueOnce(apiResponse(actionResponse));
    const getSlot = harness.handlers.get(ActivityIpc.HostGetSlot);
    const executeAction = harness.handlers.get(ActivityIpc.HostExecuteAction);

    await getSlot?.(harness.event, {
      placement: ActivityPlacement.DesktopSidebar,
    });
    const rejected = await executeAction?.(harness.event, {
      placement: ActivityPlacement.DesktopSidebar,
      activityCode: activityDescriptor.activityCode,
      configRevision: activityDescriptor.configRevision + 1,
      actionId: DailyCheckInAction.CheckIn,
      idempotencyKey: 'request-1',
    });
    expect(rejected).toEqual({
      success: false,
      error: 'Activity binding is no longer available',
    });
    expect(harness.fetchWithAuth).toHaveBeenCalledTimes(1);

    const accepted = await executeAction?.(harness.event, {
      placement: ActivityPlacement.DesktopSidebar,
      activityCode: activityDescriptor.activityCode,
      configRevision: activityDescriptor.configRevision,
      actionId: DailyCheckInAction.CheckIn,
      idempotencyKey: 'request-2',
    });
    expect(accepted).toEqual({ success: true, data: actionResponse });
    expect(harness.fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://server.example/api/client-activities/login-seven-days/actions/check_in',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          configRevision: 3,
          idempotencyKey: 'request-2',
          payload: {},
        }),
      }),
    );
  });

  test('keeps sidebar and startup-modal bindings independent', async () => {
    const harness = createHarness();
    harness.fetchWithAuth
      .mockResolvedValueOnce(apiResponse({
        slotState: ActivitySlotState.Available,
        serverTime: '2026-07-30T01:00:00Z',
        activity: activityDescriptor,
      }))
      .mockResolvedValueOnce(apiResponse({
        slotState: ActivitySlotState.Available,
        serverTime: '2026-07-30T01:00:00Z',
        activity: startupDescriptor,
      }))
      .mockResolvedValueOnce(apiResponse(activityContext))
      .mockResolvedValueOnce(apiResponse(startupContext));
    const getSlot = harness.handlers.get(ActivityIpc.HostGetSlot);
    const getContext = harness.handlers.get(ActivityIpc.HostGetContext);

    await getSlot?.(harness.event, {
      placement: ActivityPlacement.DesktopSidebar,
    });
    await getSlot?.(harness.event, {
      placement: ActivityPlacement.DesktopStartupModal,
    });

    const sidebarResult = await getContext?.(harness.event, {
      placement: ActivityPlacement.DesktopSidebar,
      activityCode: activityDescriptor.activityCode,
      configRevision: activityDescriptor.configRevision,
    });
    const startupResult = await getContext?.(harness.event, {
      placement: ActivityPlacement.DesktopStartupModal,
      activityCode: startupDescriptor.activityCode,
      configRevision: startupDescriptor.configRevision,
    });

    expect(sidebarResult).toEqual({ success: true, data: activityContext });
    expect(startupResult).toEqual({ success: true, data: startupContext });
    expect(harness.fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://server.example/api/client-activities/slot'
        + '?placement=desktop_startup_modal&clientVersion=2026.7.30'
        + '&containerApiVersion=3&platform=win32',
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  test('rejects activity requests from a non-main frame', async () => {
    const harness = createHarness();
    const getSlot = harness.handlers.get(ActivityIpc.HostGetSlot);
    const untrustedEvent = {
      sender: harness.webContents,
      senderFrame: {},
    } as unknown as IpcMainInvokeEvent;

    const result = await getSlot?.(untrustedEvent, {
      placement: ActivityPlacement.DesktopSidebar,
    });

    expect(result).toEqual({
      success: false,
      error: 'Untrusted activity host sender',
    });
    expect(harness.fetchPublic).not.toHaveBeenCalled();
    expect(harness.fetchWithAuth).not.toHaveBeenCalled();
  });
});
