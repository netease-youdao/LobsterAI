import {
  ActivityPlacement,
  type ActivityResult,
  ActivityServerErrorCode,
  ActivitySlotState,
  DailyCheckInAction,
  type DailyCheckInActionResponse,
  type DailyCheckInContextResponse,
  type DailyCheckInDescriptor,
} from '@shared/activity/constants';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useSelector } from 'react-redux';

import { authService } from '../services/auth';
import { i18nService } from '../services/i18n';
import type { RootState } from '../store';
import {
  canClaimDailyCheckIn,
  getDailyCheckInAuthScopeKey,
  isActiveDailyCheckInContext,
  isDailyCheckInContext,
  isDailyCheckInDescriptor,
} from './dailyCheckInActivityState';
import {
  getDailyCheckInDayBoundaryDelay,
  startDailyCheckInAutoRefresh,
} from './dailyCheckInAutoRefresh';
import { logSidebarExperienceDiagnostic } from './sidebarExperienceDiagnostics';

const DAILY_CHECK_IN_UPDATED_EVENT = 'lobster:daily-check-in-updated';

interface DailyCheckInLoadOptions {
  retryRevision?: boolean;
  silent?: boolean;
}

export const DailyCheckInLoadResultStatus = {
  Ready: 'ready',
  Unavailable: 'unavailable',
  Failed: 'failed',
} as const;

export interface DailyCheckInSnapshot {
  descriptor: DailyCheckInDescriptor;
  context: DailyCheckInContextResponse;
}

type DailyCheckInLoadResult =
  | {
      status: typeof DailyCheckInLoadResultStatus.Ready;
      snapshot: DailyCheckInSnapshot;
    }
  | {
      status: typeof DailyCheckInLoadResultStatus.Unavailable;
    }
  | {
      status: typeof DailyCheckInLoadResultStatus.Failed;
      code?: number;
    };

interface ScopedDailyCheckInSnapshot {
  accountScope: string;
  snapshot: DailyCheckInSnapshot;
}

export interface UseDailyCheckInActivityOptions {
  enabled?: boolean;
  autoRefresh?: boolean;
  initialSnapshot?: DailyCheckInSnapshot | null;
  loadOnMount?: boolean;
}

export interface UseDailyCheckInActivityResult {
  snapshot: DailyCheckInSnapshot | null;
  loading: boolean;
  claiming: boolean;
  refresh: () => Promise<void>;
  claim: () => Promise<DailyCheckInActionResponse>;
}

export class DailyCheckInRequestError extends Error {
  readonly code?: number;

  constructor(result: Extract<ActivityResult<never>, { success: false }>) {
    super(result.error);
    this.name = 'DailyCheckInRequestError';
    this.code = result.code;
  }
}

export class DailyCheckInStaleRequestError extends Error {
  constructor() {
    super('Daily check-in request no longer belongs to the active account');
    this.name = 'DailyCheckInStaleRequestError';
  }
}

export async function loadDailyCheckInSnapshot({
  retryRevision = true,
}: Pick<DailyCheckInLoadOptions, 'retryRevision'> = {}): Promise<DailyCheckInLoadResult> {
  const slot = await window.electron.activity.getSlot({
    placement: ActivityPlacement.DesktopSidebar,
  });
  if (!slot.success) {
    return {
      status: DailyCheckInLoadResultStatus.Failed,
      code: slot.code,
    };
  }
  if (!slot.data
      || slot.data.slotState !== ActivitySlotState.Available
      || !isDailyCheckInDescriptor(slot.data.activity)) {
    return { status: DailyCheckInLoadResultStatus.Unavailable };
  }

  const descriptor = slot.data.activity;
  const context = await window.electron.activity.getContext({
    placement: ActivityPlacement.DesktopSidebar,
    activityCode: descriptor.activityCode,
    configRevision: descriptor.configRevision,
  });
  if (!context.success) {
    if (retryRevision
        && context.code === ActivityServerErrorCode.RevisionMismatch) {
      return loadDailyCheckInSnapshot({ retryRevision: false });
    }
    return {
      status: DailyCheckInLoadResultStatus.Failed,
      code: context.code,
    };
  }
  if (!isActiveDailyCheckInContext(context.data)
      || context.data.activityCode !== descriptor.activityCode
      || context.data.configRevision !== descriptor.configRevision) {
    return { status: DailyCheckInLoadResultStatus.Unavailable };
  }
  return {
    status: DailyCheckInLoadResultStatus.Ready,
    snapshot: { descriptor, context: context.data },
  };
}

function createIdempotencyKey(): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `daily-check-in-${suffix}`.slice(0, 64);
}

export function useDailyCheckInActivity(
  {
    enabled = true,
    autoRefresh = true,
    initialSnapshot = null,
    loadOnMount = true,
  }: UseDailyCheckInActivityOptions = {},
): UseDailyCheckInActivityResult {
  const authAccountScope = useSelector(
    (state: RootState) => getDailyCheckInAuthScopeKey(
      state.auth.ownerAccountKey,
      state.auth.accountGeneration,
    ),
  );
  const [scopedSnapshot, setScopedSnapshot] = useState<ScopedDailyCheckInSnapshot | null>(
    () => (initialSnapshot
      ? {
        accountScope: authAccountScope,
        snapshot: initialSnapshot,
      }
      : null),
  );
  const snapshot = scopedSnapshot?.accountScope === authAccountScope
    ? scopedSnapshot.snapshot
    : null;
  const [loading, setLoading] = useState(enabled && loadOnMount);
  const [claiming, setClaiming] = useState(false);
  const loadRequestIdRef = useRef(0);
  const claimingRef = useRef(false);
  const mountedRef = useRef(true);
  const authAccountScopeRef = useRef(authAccountScope);
  authAccountScopeRef.current = authAccountScope;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestIdRef.current += 1;
    };
  }, []);

  const load = useCallback(async ({
    retryRevision = true,
    silent = false,
  }: DailyCheckInLoadOptions = {}): Promise<void> => {
    const requestAccountScope = authAccountScope;
    const requestId = ++loadRequestIdRef.current;
    const isCurrentRequest = () => (
      mountedRef.current
      && loadRequestIdRef.current === requestId
      && authAccountScopeRef.current === requestAccountScope
    );
    if (!enabled) {
      if (isCurrentRequest()) {
        setScopedSnapshot(null);
        setLoading(false);
      }
      return;
    }
    if (isCurrentRequest() && !silent) setLoading(true);
    try {
      const result = await loadDailyCheckInSnapshot({ retryRevision });
      if (!isCurrentRequest()) return;
      if (result.status === DailyCheckInLoadResultStatus.Ready) {
        setScopedSnapshot({
          accountScope: requestAccountScope,
          snapshot: result.snapshot,
        });
        return;
      }
      if (result.status === DailyCheckInLoadResultStatus.Unavailable) {
        setScopedSnapshot(null);
        return;
      }
      if (!silent
          || result.code === ActivityServerErrorCode.NotActive
          || result.code === ActivityServerErrorCode.NotFound) {
        setScopedSnapshot(null);
      }
    } catch (error) {
      if (isCurrentRequest()) {
        logSidebarExperienceDiagnostic(
          'warn',
          'failed to load daily check-in activity',
          error,
        );
        if (!silent) setScopedSnapshot(null);
      }
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [authAccountScope, enabled]);

  const refresh = useCallback(
    () => load({ silent: true }),
    [load],
  );

  useEffect(() => {
    if (!loadOnMount) {
      setLoading(false);
      return;
    }
    void load();
  }, [authAccountScope, load, loadOnMount]);

  useEffect(() => {
    if (!enabled) return undefined;
    const handleActivityUpdate = () => void refresh();
    window.addEventListener(
      DAILY_CHECK_IN_UPDATED_EVENT,
      handleActivityUpdate,
    );
    return () => window.removeEventListener(
      DAILY_CHECK_IN_UPDATED_EVENT,
      handleActivityUpdate,
    );
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || !autoRefresh) return undefined;
    return startDailyCheckInAutoRefresh(refresh);
  }, [autoRefresh, enabled, refresh]);

  useEffect(() => {
    if (!enabled || !autoRefresh || !snapshot) return undefined;
    const delay = getDailyCheckInDayBoundaryDelay(
      snapshot.context.serverTime,
      snapshot.context.state.timezone,
    );
    if (delay === null) return undefined;
    const timer = setTimeout(() => void refresh(), delay);
    return () => clearTimeout(timer);
  }, [autoRefresh, enabled, refresh, snapshot]);

  const claim = useCallback(async (): Promise<DailyCheckInActionResponse> => {
    const target = snapshot;
    if (!target || !canClaimDailyCheckIn(target.context)) {
      throw new Error(i18nService.t('dailyCheckInClaimFailed'));
    }
    if (claimingRef.current) {
      throw new Error(i18nService.t('dailyCheckInClaimFailed'));
    }
    const requestAccountScope = authAccountScope;
    claimingRef.current = true;
    if (mountedRef.current) setClaiming(true);
    try {
      const result = await window.electron.activity.executeAction({
        placement: ActivityPlacement.DesktopSidebar,
        activityCode: target.descriptor.activityCode,
        configRevision: target.descriptor.configRevision,
        actionId: DailyCheckInAction.CheckIn,
        idempotencyKey: createIdempotencyKey(),
      });
      if (!mountedRef.current
          || authAccountScopeRef.current !== requestAccountScope) {
        throw new DailyCheckInStaleRequestError();
      }
      if (!result.success) {
        if (result.code === ActivityServerErrorCode.AlreadyClaimed
            || result.code === ActivityServerErrorCode.RevisionMismatch
            || result.code === ActivityServerErrorCode.LoginRequired) {
          await refresh();
        } else if (result.code === ActivityServerErrorCode.NotActive
            || result.code === ActivityServerErrorCode.NotFound) {
          loadRequestIdRef.current += 1;
          setScopedSnapshot(null);
        }
        throw new DailyCheckInRequestError(result);
      }
      if (!result.data
          || !isDailyCheckInContext(result.data.context)
          || result.data.context.activityCode !== target.descriptor.activityCode
          || result.data.context.configRevision !== target.descriptor.configRevision
          || !result.data.result
          || result.data.result.activityCode !== target.descriptor.activityCode
          || result.data.result.actionId !== DailyCheckInAction.CheckIn
          || !Number.isFinite(result.data.result.creditsGranted)
          || result.data.result.creditsGranted <= 0) {
        await refresh();
        throw new Error(i18nService.t('dailyCheckInClaimFailed'));
      }
      loadRequestIdRef.current += 1;
      setScopedSnapshot({
        accountScope: requestAccountScope,
        snapshot: {
          descriptor: target.descriptor,
          context: result.data.context,
        },
      });
      window.dispatchEvent(new Event(DAILY_CHECK_IN_UPDATED_EVENT));
      void authService.fetchProfileSummary();
      return result.data as DailyCheckInActionResponse;
    } finally {
      claimingRef.current = false;
      if (mountedRef.current) setClaiming(false);
    }
  }, [authAccountScope, refresh, snapshot]);

  return {
    snapshot,
    loading,
    claiming,
    refresh,
    claim,
  };
}
