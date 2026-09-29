import { useCallback, useEffect, useRef, useState } from 'react';

import type { OpenClawProgressCard, ProgressCardResponse } from '../../../shared/cowork/progressCard';

/**
 * A session's native OpenClaw progress card: read when the session opens,
 * reread whenever the Gateway reports a change (or the connection comes
 * back), and cleared on request. A failed read keeps the card last shown.
 */
export const useOpenClawProgressCard = (sessionId: string) => {
  const [card, setCard] = useState<OpenClawProgressCard | null>(null);
  // Hidden as soon as the user closes it; restored if clearing fails.
  const [dismissedRevision, setDismissedRevision] = useState<number | null>(null);
  // Replies to superseded requests (an older read, another session) are dropped.
  const requestSequence = useRef(0);

  const apply = useCallback(async (request: () => Promise<ProgressCardResponse>): Promise<boolean> => {
    const sequence = ++requestSequence.current;
    try {
      const response = await request();
      if (sequence !== requestSequence.current) return true;
      if (!response.success || response.card === undefined) return false;
      setCard(response.card);
      return true;
    } catch (error) {
      console.debug('[ProgressCard] request failed:', error);
      return false;
    }
  }, []);

  const reload = useCallback(
    () => apply(() => window.electron.cowork.getProgressCard(sessionId)),
    [apply, sessionId],
  );

  useEffect(() => {
    setCard(null);
    setDismissedRevision(null);
    const unsubscribe = window.electron.cowork.onProgressCardChanged((event) => {
      if (event.sessionId === sessionId) void reload();
    });
    void reload();
    return () => {
      requestSequence.current += 1;
      unsubscribe();
    };
  }, [reload, sessionId]);

  const dismiss = useCallback(async (revision: number) => {
    setDismissedRevision(revision);
    const cleared = await apply(() => window.electron.cowork.dismissProgressCard(sessionId, revision));
    if (!cleared) setDismissedRevision(null);
  }, [apply, sessionId]);

  return {
    card: card && card.revision !== dismissedRevision ? card : null,
    dismiss,
  };
};
