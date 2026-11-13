import { useState } from 'react';

import { COWORK_TEMP_SESSION_ID_PREFIX } from '../../../shared/cowork/constants';

export interface EntryAnimationState {
  sessionId: string | undefined;
  /** Id of the turn that must not play the entry animation. */
  skipTurnId: string | null;
  /**
   * The turn with id `turnId` is mounted under React key `key`. Recorded for
   * the optimistic first turn, so the stored copy that replaces it (same turn,
   * another id) takes over the mount instead of being mounted again.
   */
  mountedTurn: { turnId: string; key: string } | null;
}

const isOptimisticSession = (sessionId: string | undefined): boolean =>
  Boolean(sessionId?.startsWith(COWORK_TEMP_SESSION_ID_PREFIX));

/**
 * The newest turn fades in when it is appended. That animation is a CSS class,
 * so it replays whenever the class is re-applied or the turn is remounted even
 * though nothing new arrived: the optimistic first turn being replaced by its
 * stored copy, a message version being switched, or an edit being cancelled.
 *
 * The optimistic first turn keeps its mount across the replacement: a remount
 * would also restart everything inside the turn that animates on mount (the
 * activity indicator fading in) and reset its state (the rotating status word).
 *
 * `hold` marks a moment in which the newest turn is already on screen in some
 * form; that turn stays exempt until a different turn becomes the newest.
 */
export function nextEntryAnimationState(
  state: EntryAnimationState,
  sessionId: string | undefined,
  lastTurnId: string | undefined,
  hold: boolean,
): EntryAnimationState {
  let next = state;
  if (state.sessionId !== sessionId) {
    const replacesOptimisticTurn = isOptimisticSession(state.sessionId) && Boolean(sessionId) && !isOptimisticSession(sessionId);
    const mountedTurn = replacesOptimisticTurn && lastTurnId && state.mountedTurn
      ? { turnId: lastTurnId, key: state.mountedTurn.key }
      : null;
    // A turn that keeps its mount cannot replay; only a remounted one needs the exemption.
    next = { sessionId, skipTurnId: replacesOptimisticTurn && !mountedTurn ? lastTurnId ?? null : null, mountedTurn };
  }
  if (isOptimisticSession(sessionId) && lastTurnId && next.mountedTurn?.turnId !== lastTurnId) {
    next = { ...next, mountedTurn: { turnId: lastTurnId, key: lastTurnId } };
  }
  if (hold && lastTurnId && next.skipTurnId !== lastTurnId) next = { ...next, skipTurnId: lastTurnId };
  return next;
}

/** React key of a turn: its id, unless it took over the mount of the optimistic turn it replaced. */
export const resolveTurnKey = (state: EntryAnimationState, turnId: string): string =>
  state.mountedTurn?.turnId === turnId ? state.mountedTurn.key : turnId;

export function useTurnEntryAnimation(
  sessionId: string | undefined,
  lastTurnId: string | undefined,
  hold: boolean,
): EntryAnimationState {
  const [state, setState] = useState<EntryAnimationState>({ sessionId, skipTurnId: null, mountedTurn: null });
  const next = nextEntryAnimationState(state, sessionId, lastTurnId, hold);
  // Adjusting state while rendering keeps the decision in the same commit that mounts the turn.
  if (next !== state) setState(next);
  return next;
}
