import { useCallback, useEffect, useRef, useState } from 'react';

import type { OpenClawProgressCard, ProgressCardResponse } from '../../../shared/cowork/progressCard';

export function useOpenClawProgressCard(sessionId: string) {
  const [card, setCard] = useState<OpenClawProgressCard | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const refreshRequest = useRef<{ key: string; revision?: number }>();
  const refreshingRef = useRef(false);
  const currentCard = useRef<OpenClawProgressCard | null>(null);
  const scope = useRef(0);
  const refreshAttempt = useRef(0);
  const sequence = useRef(0);
  const dismissing = useRef(false);
  const run = useCallback(async (request: () => Promise<ProgressCardResponse>) => {
    const version = ++sequence.current;
    try {
      const result = await request();
      if (version !== sequence.current) return;
      if (!result.success || result.card === undefined) throw new Error('Unavailable');
      if (currentCard.current && result.card && currentCard.current.sessionKey !== result.card.sessionKey) {
        ++scope.current; ++refreshAttempt.current;
        refreshRequest.current = undefined; refreshingRef.current = false;
        setRefreshing(false); setRefreshError(false);
      }
      currentCard.current = result.card;
      setCard(result.card); setError(false);
      const pending = refreshRequest.current;
      if (pending?.revision !== undefined && (!result.card || result.card.revision > pending.revision)) {
        refreshRequest.current = undefined;
        refreshingRef.current = false; setRefreshing(false); setRefreshError(false);
      }
    } catch { if (version === sequence.current) setError(true); }
  }, []);
  const reload = useCallback(() => run(() => window.electron.cowork.getProgressCard(sessionId)), [sessionId, run]);
  useEffect(() => {
    const invalidate = () => { ++sequence.current; ++scope.current; };
    ++scope.current;
    currentCard.current = null;
    refreshRequest.current = undefined; refreshingRef.current = false;
    setRefreshing(false); setRefreshError(false);
    setCard(null); setError(false);
    const off = window.electron.cowork.onProgressCardChanged(event => {
      if (event.sessionId === sessionId) void reload();
    });
    void reload();
    return () => { invalidate(); off(); };
  }, [sessionId, reload]);
  const refresh = useCallback(async () => {
    if (!currentCard.current || refreshingRef.current) return;
    const version = scope.current;
    const attempt = ++refreshAttempt.current;
    const pending = refreshRequest.current ?? { key: crypto.randomUUID() };
    refreshRequest.current = pending;
    refreshingRef.current = true; setRefreshing(true); setRefreshError(false);
    try {
      const response = await window.electron.cowork.refreshProgressCard(sessionId, pending.key);
      if (scope.current !== version || refreshAttempt.current !== attempt || refreshRequest.current !== pending) return;
      if (!response.success || !response.receipt) {
        if (response.terminal) refreshRequest.current = undefined;
        throw new Error('Unavailable');
      }
      pending.revision = response.receipt.revision;
      if (!currentCard.current || currentCard.current.revision > pending.revision) {
        refreshRequest.current = undefined;
        refreshingRef.current = false; setRefreshing(false);
      } else {
        await reload();
      }
    } catch {
      if (scope.current === version && refreshAttempt.current === attempt) {
        refreshingRef.current = false; setRefreshing(false); setRefreshError(true);
      }
    }
  }, [sessionId, reload]);
  useEffect(() => {
    if (!refreshing) return;
    const interval = setInterval(() => { void reload(); }, 2_000);
    const timeout = setTimeout(() => {
      ++refreshAttempt.current;
      // A received ACK followed by no new card is an exhausted status request.
      // The next explicit click is a new intent; an unknown/lost ACK keeps its key.
      if (refreshRequest.current?.revision !== undefined) refreshRequest.current = undefined;
      refreshingRef.current = false; setRefreshing(false); setRefreshError(true);
    }, 45_000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [refreshing, reload]);
  const dismiss = useCallback(async () => {
    if (!card || dismissing.current) return;
    dismissing.current = true; setBusy(true);
    try { await run(() => window.electron.cowork.dismissProgressCard(sessionId, card.revision)); }
    finally { dismissing.current = false; setBusy(false); }
  }, [card, sessionId, run]);
  return { card, error, busy, reload, dismiss, refresh, refreshing, refreshError };
}
