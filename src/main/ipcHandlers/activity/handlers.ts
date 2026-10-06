import {
  type BrowserWindow,
  type IpcMain,
  type IpcMainInvokeEvent,
} from 'electron';

import {
  ActivityContainerApiVersion,
  type ActivityHostExecuteActionInput,
  type ActivityHostGetContextInput,
  type ActivityHostGetSlotInput,
  ActivityIpc,
  ActivityPlacement,
  type ActivityPlacement as ActivityPlacementType,
  type ActivityResult,
  ActivitySlotState,
} from '../../../shared/activity/constants';
import { AuthSessionStatus } from '../../../shared/auth/constants';
import {
  ActivityAuthMode,
  type ActivityFetch,
  executeActivityAction,
  getActivityContext,
  getActivitySlot,
} from '../../libs/activity/activityClient';
import { resolveAuthSessionStatusFromError } from '../../libs/authSessionManager';

export interface ActivityIpcHandlerDeps {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  getServerBaseUrl: () => string;
  getClientVersion: () => string;
  platform: string;
  hasAuthTokens: () => boolean;
  fetchPublic: (url: string, init?: RequestInit) => Promise<Response>;
  fetchWithAuth: (url: string, init?: RequestInit) => Promise<Response>;
}

const failure = (error: unknown): ActivityResult<never> => ({
  success: false,
  error: error instanceof Error ? error.message : 'Activity operation failed',
});

const containerApiVersionByPlacement: Record<ActivityPlacementType, number> = {
  [ActivityPlacement.DesktopSidebar]:
    ActivityContainerApiVersion.NativeDailyCheckInV1,
  [ActivityPlacement.DesktopStartupModal]:
    ActivityContainerApiVersion.NativeStartupCreditV1,
};

function validateSlotInput(
  input: ActivityHostGetSlotInput | undefined,
): asserts input is ActivityHostGetSlotInput {
  if (!input
      || !Object.values(ActivityPlacement).includes(input.placement)) {
    throw new Error('Invalid activity placement');
  }
}

function validateActivityBinding(
  input: ActivityHostGetContextInput | undefined,
): asserts input is ActivityHostGetContextInput {
  if (!input
      || !Object.values(ActivityPlacement).includes(input.placement)
      || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(input.activityCode)
      || !Number.isInteger(input.configRevision)
      || input.configRevision < 1) {
    throw new Error('Invalid activity binding');
  }
}

function validateExecuteInput(
  input: ActivityHostExecuteActionInput | undefined,
): asserts input is ActivityHostExecuteActionInput {
  validateActivityBinding(input);
  if (!/^[a-z0-9_-]{1,64}$/.test(input.actionId)
      || !/^[A-Za-z0-9._:-]{1,64}$/.test(input.idempotencyKey)) {
    throw new Error('Invalid activity idempotency key');
  }
}

export function registerActivityIpcHandlers(deps: ActivityIpcHandlerDeps): void {
  const actionsInFlight = new Set<string>();
  const activeBindings = new Map<
    ActivityPlacementType,
    ActivityHostGetContextInput
  >();

  const activityFetch: ActivityFetch = async (url, init, authMode) => {
    if (authMode === ActivityAuthMode.Required) {
      return deps.fetchWithAuth(url, init);
    }
    if (!deps.hasAuthTokens()) {
      return deps.fetchPublic(url, init);
    }
    try {
      return await deps.fetchWithAuth(url, init);
    } catch (error) {
      const status = resolveAuthSessionStatusFromError(error);
      if (status === AuthSessionStatus.Unauthenticated
          || status === AuthSessionStatus.Expired) {
        return deps.fetchPublic(url, init);
      }
      throw error;
    }
  };

  const requireMainRenderer = (event: IpcMainInvokeEvent): void => {
    const mainWindow = deps.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()
        || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Untrusted activity host sender');
    }
  };

  const loadSlot = async (input: ActivityHostGetSlotInput) => {
    validateSlotInput(input);
    const result = await getActivitySlot(
      deps.getServerBaseUrl(),
      activityFetch,
      {
        placement: input.placement,
        clientVersion: deps.getClientVersion(),
        containerApiVersion: containerApiVersionByPlacement[input.placement],
        platform: deps.platform,
      },
    );
    if (result.success) {
      activeBindings.delete(input.placement);
      if (result.data.slotState === ActivitySlotState.Available && result.data.activity) {
        validateActivityBinding(result.data.activity);
        if (result.data.activity.placement !== input.placement) {
          throw new Error('Activity placement does not match the requested slot');
        }
        activeBindings.set(input.placement, {
          placement: input.placement,
          activityCode: result.data.activity.activityCode,
          configRevision: result.data.activity.configRevision,
        });
      }
    }
    return result;
  };

  function requireActiveBinding(
    input: ActivityHostGetContextInput | undefined,
  ): asserts input is ActivityHostGetContextInput {
    validateActivityBinding(input);
    const activeBinding = activeBindings.get(input.placement);
    if (!activeBinding
        || activeBinding.activityCode !== input.activityCode
        || activeBinding.configRevision !== input.configRevision) {
      throw new Error('Activity binding is no longer available');
    }
  }

  deps.ipcMain.handle(
    ActivityIpc.HostGetSlot,
    async (event, input?: ActivityHostGetSlotInput) => {
      try {
        requireMainRenderer(event);
        validateSlotInput(input);
        return await loadSlot(input);
      } catch (error) {
        return failure(error);
      }
    },
  );

  deps.ipcMain.handle(
    ActivityIpc.HostGetContext,
    async (event, input?: ActivityHostGetContextInput) => {
      try {
        requireMainRenderer(event);
        requireActiveBinding(input);
        return await getActivityContext(
          deps.getServerBaseUrl(),
          activityFetch,
          input.activityCode,
          input.configRevision,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  deps.ipcMain.handle(
    ActivityIpc.HostExecuteAction,
    async (event, input?: ActivityHostExecuteActionInput) => {
      try {
        requireMainRenderer(event);
        validateExecuteInput(input);
        requireActiveBinding(input);
        const actionKey = [
          input.placement,
          input.activityCode,
          input.configRevision,
          input.actionId,
        ].join(':');
        if (actionsInFlight.has(actionKey)) {
          return {
            success: false,
            error: 'An activity action is already in progress',
          } satisfies ActivityResult<never>;
        }
        actionsInFlight.add(actionKey);
        try {
          return await executeActivityAction(
            deps.getServerBaseUrl(),
            activityFetch,
            input,
          );
        } finally {
          actionsInFlight.delete(actionKey);
        }
      } catch (error) {
        return failure(error);
      }
    },
  );
}
