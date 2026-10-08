import { describe, expect, test } from 'vitest';

import {
  getLibraryLoadingPresentation,
  getLibraryLoadingTimingState,
  getLibraryQueryLoadCause,
  LibraryLoadCause,
  LibraryLoadingTiming,
  type LibraryQueryIdentity,
  shouldResetLibraryScrollOnCommit,
} from './libraryLoadingPresentation';
import { LibraryLoadPhase } from './libraryLocalQueryState';

const makeQuery = (
  overrides: Partial<LibraryQueryIdentity> = {},
): LibraryQueryIdentity => ({
  source: 'local',
  scopeKey: 'account-a',
  category: 'all',
  keyword: '',
  favoritesOnly: false,
  availability: 'all',
  ...overrides,
});

describe('library loading presentation', () => {
  test('identifies query causes with scope-safe priority', () => {
    const base = makeQuery();

    expect(getLibraryQueryLoadCause(undefined, base)).toBe(LibraryLoadCause.Initial);
    expect(getLibraryQueryLoadCause(base, makeQuery({ source: 'cloud' })))
      .toBe(LibraryLoadCause.SourceSwitch);
    expect(getLibraryQueryLoadCause(base, makeQuery({ scopeKey: 'account-b' })))
      .toBe(LibraryLoadCause.AccountSwitch);
    expect(getLibraryQueryLoadCause(base, makeQuery({ keyword: 'budget' })))
      .toBe(LibraryLoadCause.Search);
    expect(getLibraryQueryLoadCause(base, makeQuery({ favoritesOnly: true })))
      .toBe(LibraryLoadCause.Filter);
  });

  test('keeps requests below the visible threshold silent', () => {
    expect(getLibraryLoadingTimingState(
      LibraryLoadPhase.Revalidating,
      LibraryLoadCause.Search,
      LibraryLoadingTiming.VisibleDelayMs - 1,
    )).toEqual({
      delayedVisible: false,
      longWait: false,
    });
    expect(getLibraryLoadingTimingState(
      LibraryLoadPhase.Revalidating,
      LibraryLoadCause.Search,
      LibraryLoadingTiming.VisibleDelayMs,
    )).toEqual({
      delayedVisible: true,
      longWait: false,
    });
  });

  test('shows long-wait text only after one second', () => {
    expect(getLibraryLoadingTimingState(
      LibraryLoadPhase.Revalidating,
      LibraryLoadCause.Filter,
      LibraryLoadingTiming.LongWaitDelayMs - 1,
    ).longWait).toBe(false);
    expect(getLibraryLoadingTimingState(
      LibraryLoadPhase.Revalidating,
      LibraryLoadCause.Filter,
      LibraryLoadingTiming.LongWaitDelayMs,
    ).longWait).toBe(true);
  });

  test('keeps background refresh silent and manual refresh immediate', () => {
    expect(getLibraryLoadingTimingState(
      LibraryLoadPhase.Refreshing,
      LibraryLoadCause.BackgroundRefresh,
      5_000,
    )).toEqual({
      delayedVisible: false,
      longWait: false,
    });
    expect(getLibraryLoadingTimingState(
      LibraryLoadPhase.Refreshing,
      LibraryLoadCause.ManualRefresh,
      0,
    ).delayedVisible).toBe(true);
  });

  test('uses a delayed skeleton only when no safe snapshot exists', () => {
    const beforeDelay = getLibraryLoadingPresentation({
      phase: LibraryLoadPhase.Initial,
      cause: LibraryLoadCause.AccountSwitch,
      hasResolvedSnapshot: false,
      timing: { delayedVisible: false, longWait: false },
    });
    const afterDelay = getLibraryLoadingPresentation({
      phase: LibraryLoadPhase.Initial,
      cause: LibraryLoadCause.AccountSwitch,
      hasResolvedSnapshot: false,
      timing: { delayedVisible: true, longWait: false },
    });

    expect(beforeDelay.initialPending).toBe(true);
    expect(beforeDelay.showInitialSkeleton).toBe(false);
    expect(afterDelay.showInitialSkeleton).toBe(true);
    expect(afterDelay.showSourceActivity).toBe(false);
  });

  test('maps each warm operation to only its contextual indicator', () => {
    const search = getLibraryLoadingPresentation({
      phase: LibraryLoadPhase.Revalidating,
      cause: LibraryLoadCause.Search,
      hasResolvedSnapshot: true,
      timing: { delayedVisible: true, longWait: false },
    });
    const append = getLibraryLoadingPresentation({
      phase: LibraryLoadPhase.Appending,
      cause: LibraryLoadCause.Append,
      hasResolvedSnapshot: true,
      timing: { delayedVisible: true, longWait: false },
    });

    expect(search.showSearchActivity).toBe(true);
    expect(search.showFilterActivity).toBe(false);
    expect(search.showManualRefreshActivity).toBe(false);
    expect(append.showAppendActivity).toBe(true);
    expect(append.showSearchActivity).toBe(false);
  });

  test('resets scroll only when a new result set commits', () => {
    expect(shouldResetLibraryScrollOnCommit(LibraryLoadCause.Search)).toBe(true);
    expect(shouldResetLibraryScrollOnCommit(LibraryLoadCause.Filter)).toBe(true);
    expect(shouldResetLibraryScrollOnCommit(LibraryLoadCause.SourceSwitch)).toBe(true);
    expect(shouldResetLibraryScrollOnCommit(LibraryLoadCause.AccountSwitch)).toBe(true);
    expect(shouldResetLibraryScrollOnCommit(LibraryLoadCause.ManualRefresh)).toBe(false);
    expect(shouldResetLibraryScrollOnCommit(LibraryLoadCause.BackgroundRefresh)).toBe(false);
    expect(shouldResetLibraryScrollOnCommit(LibraryLoadCause.Append)).toBe(false);
  });
});
