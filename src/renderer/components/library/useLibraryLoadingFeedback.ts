import { useEffect, useRef, useState } from 'react';

import {
  getLibraryLoadingPresentation,
  getLibraryLoadingTimingState,
  LibraryLoadCause,
  type LibraryLoadCause as LibraryLoadCauseValue,
  type LibraryLoadingPresentation,
  LibraryLoadingTiming,
} from './libraryLoadingPresentation';
import {
  LibraryLoadPhase,
  type LibraryLoadPhase as LibraryLoadPhaseValue,
} from './libraryLocalQueryState';

interface UseLibraryLoadingFeedbackOptions {
  activityId: number;
  phase: LibraryLoadPhaseValue;
  cause: LibraryLoadCauseValue;
  hasResolvedSnapshot: boolean;
}

interface TimedActivity {
  activityId: number;
  delayedVisible: boolean;
  longWait: boolean;
}

const INACTIVE_TIMING: TimedActivity = {
  activityId: -1,
  delayedVisible: false,
  longWait: false,
};

export const useLibraryLoadingFeedback = ({
  activityId,
  phase,
  cause,
  hasResolvedSnapshot,
}: UseLibraryLoadingFeedbackOptions): LibraryLoadingPresentation => {
  const [timedActivity, setTimedActivity] = useState<TimedActivity>(INACTIVE_TIMING);
  const [completionActivityId, setCompletionActivityId] = useState(-1);
  const longWaitActivityIdRef = useRef(-1);
  const initialTiming = getLibraryLoadingTimingState(phase, cause, 0);
  const timing = timedActivity.activityId === activityId
    ? timedActivity
    : initialTiming;

  useEffect(() => {
    if (
      phase === LibraryLoadPhase.Settled
      || cause === LibraryLoadCause.BackgroundRefresh
    ) {
      return undefined;
    }

    const visibleTimer = initialTiming.delayedVisible
      ? undefined
      : window.setTimeout(() => {
          setTimedActivity({
            activityId,
            ...getLibraryLoadingTimingState(
              phase,
              cause,
              LibraryLoadingTiming.VisibleDelayMs,
            ),
          });
        }, LibraryLoadingTiming.VisibleDelayMs);
    const longWaitTimer = window.setTimeout(() => {
      setTimedActivity({
        activityId,
        ...getLibraryLoadingTimingState(
          phase,
          cause,
          LibraryLoadingTiming.LongWaitDelayMs,
        ),
      });
    }, LibraryLoadingTiming.LongWaitDelayMs);

    return () => {
      if (visibleTimer !== undefined) window.clearTimeout(visibleTimer);
      window.clearTimeout(longWaitTimer);
    };
  }, [
    activityId,
    cause,
    initialTiming.delayedVisible,
    phase,
  ]);

  useEffect(() => {
    if (phase !== LibraryLoadPhase.Settled) {
      if (timing.longWait) longWaitActivityIdRef.current = activityId;
      return undefined;
    }
    if (longWaitActivityIdRef.current !== activityId) return undefined;
    longWaitActivityIdRef.current = -1;
    setCompletionActivityId(activityId);
    const timer = window.setTimeout(() => {
      setCompletionActivityId(current => current === activityId ? -1 : current);
    }, LibraryLoadingTiming.LongWaitDelayMs);
    return () => window.clearTimeout(timer);
  }, [activityId, phase, timing.longWait]);

  return {
    ...getLibraryLoadingPresentation({
      phase,
      cause,
      hasResolvedSnapshot,
      timing,
    }),
    announceCompletion: completionActivityId === activityId,
  };
};
