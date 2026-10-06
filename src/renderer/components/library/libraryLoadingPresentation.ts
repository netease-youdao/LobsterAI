import {
  LibraryLoadPhase,
  type LibraryLoadPhase as LibraryLoadPhaseValue,
} from './libraryLocalQueryState';

export const LibraryLoadCause = {
  Initial: 'initial',
  Search: 'search',
  Filter: 'filter',
  SourceSwitch: 'source-switch',
  AccountSwitch: 'account-switch',
  ManualRefresh: 'manual-refresh',
  BackgroundRefresh: 'background-refresh',
  Append: 'append',
} as const;
export type LibraryLoadCause = typeof LibraryLoadCause[keyof typeof LibraryLoadCause];

export const LibraryLoadingTiming = {
  VisibleDelayMs: 200,
  LongWaitDelayMs: 1_000,
} as const;

export interface LibraryQueryIdentity {
  source: string;
  scopeKey: string;
  category: string;
  keyword: string;
  favoritesOnly: boolean;
  availability: string;
}

export interface LibraryLoadingTimingState {
  delayedVisible: boolean;
  longWait: boolean;
}

export interface LibraryLoadingPresentation {
  initialPending: boolean;
  showInitialSkeleton: boolean;
  showSearchActivity: boolean;
  showFilterActivity: boolean;
  showSourceActivity: boolean;
  showManualRefreshActivity: boolean;
  showAppendActivity: boolean;
  showLongWaitLabel: boolean;
  announceCompletion: boolean;
  ariaBusy: boolean;
}

export interface LibraryLoadingPresentationInput {
  phase: LibraryLoadPhaseValue;
  cause: LibraryLoadCause;
  hasResolvedSnapshot: boolean;
  timing: LibraryLoadingTimingState;
}

const isActiveLibraryLoad = (phase: LibraryLoadPhaseValue): boolean => (
  phase !== LibraryLoadPhase.Settled
);

const isImmediateLibraryFeedback = (
  phase: LibraryLoadPhaseValue,
  cause: LibraryLoadCause,
): boolean => (
  phase === LibraryLoadPhase.Appending
  || cause === LibraryLoadCause.ManualRefresh
);

export const getLibraryQueryLoadCause = (
  previous: LibraryQueryIdentity | undefined,
  current: LibraryQueryIdentity,
): LibraryLoadCause => {
  if (!previous) return LibraryLoadCause.Initial;
  if (previous.source !== current.source) return LibraryLoadCause.SourceSwitch;
  if (previous.scopeKey !== current.scopeKey) return LibraryLoadCause.AccountSwitch;
  if (previous.keyword !== current.keyword) return LibraryLoadCause.Search;
  if (
    previous.category !== current.category
    || previous.favoritesOnly !== current.favoritesOnly
    || previous.availability !== current.availability
  ) {
    return LibraryLoadCause.Filter;
  }
  return LibraryLoadCause.Initial;
};

export const getLibraryLoadingTimingState = (
  phase: LibraryLoadPhaseValue,
  cause: LibraryLoadCause,
  elapsedMs: number,
): LibraryLoadingTimingState => {
  if (
    !isActiveLibraryLoad(phase)
    || cause === LibraryLoadCause.BackgroundRefresh
  ) {
    return {
      delayedVisible: false,
      longWait: false,
    };
  }
  return {
    delayedVisible: isImmediateLibraryFeedback(phase, cause)
      || elapsedMs >= LibraryLoadingTiming.VisibleDelayMs,
    longWait: elapsedMs >= LibraryLoadingTiming.LongWaitDelayMs,
  };
};

export const getLibraryLoadingPresentation = ({
  phase,
  cause,
  hasResolvedSnapshot,
  timing,
}: LibraryLoadingPresentationInput): LibraryLoadingPresentation => {
  const active = isActiveLibraryLoad(phase);
  const foreground = active && cause !== LibraryLoadCause.BackgroundRefresh;
  const initialPending = foreground
    && phase !== LibraryLoadPhase.Appending
    && !hasResolvedSnapshot;
  const showContextualActivity = foreground
    && !initialPending
    && timing.delayedVisible;

  return {
    initialPending,
    showInitialSkeleton: initialPending && timing.delayedVisible,
    showSearchActivity: showContextualActivity && cause === LibraryLoadCause.Search,
    showFilterActivity: showContextualActivity && cause === LibraryLoadCause.Filter,
    showSourceActivity: showContextualActivity && cause === LibraryLoadCause.SourceSwitch,
    showManualRefreshActivity: showContextualActivity
      && cause === LibraryLoadCause.ManualRefresh,
    showAppendActivity: foreground && phase === LibraryLoadPhase.Appending,
    showLongWaitLabel: showContextualActivity && timing.longWait,
    announceCompletion: false,
    ariaBusy: foreground,
  };
};

export const shouldResetLibraryScrollOnCommit = (
  cause: LibraryLoadCause,
): boolean => (
  cause === LibraryLoadCause.Search
  || cause === LibraryLoadCause.Filter
  || cause === LibraryLoadCause.SourceSwitch
  || cause === LibraryLoadCause.AccountSwitch
);
