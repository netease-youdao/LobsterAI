import { useCallback, useEffect, useRef, useState } from 'react';

import { CoworkSessionStatusValue } from '../../types/cowork';

export type CompanionSession = NonNullable<Awaited<ReturnType<typeof window.electron.cowork.getSession>>['session']>;

export function useCompanionSession(sessionId: string | null, visible: boolean) {
  const [session, setSession] = useState<CompanionSession | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadRef = useRef<() => void>(() => undefined);
  const refresh = useCallback(() => loadRef.current(), []);

  // Subscribe before a task is created, so fast permission events cannot fall
  // into the gap between startSession and selecting the returned session.
  useEffect(() => {
    let active = true;
    const api = window.electron.cowork;
    const clearSession = (id: string) => setPending(previous => Object.fromEntries(
      Object.entries(previous).filter(([, owner]) => owner !== id),
    ));
    const dismissed = new Set<string>();
    const stops = [
      api.onStreamPermission(data => setPending(previous => ({ ...previous, [data.request.requestId]: data.sessionId }))),
      api.onStreamPermissionDismiss(data => {
        dismissed.add(data.requestId);
        setPending(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== data.requestId)));
      }),
      api.onStreamSessionStatus(data => { if (data.status !== CoworkSessionStatusValue.Running) clearSession(data.sessionId); }),
      api.onStreamComplete(data => clearSession(data.sessionId)),
      api.onStreamError(data => clearSession(data.sessionId)),
    ];
    void api.getPendingQuestions?.().then(questions => {
      if (active) setPending(previous => ({
        ...Object.fromEntries(questions.filter(q => !dismissed.has(q.requestId)).map(q => [q.requestId, q.sessionId])),
        ...previous,
      }));
    }).catch(() => undefined);
    return () => { active = false; stops.forEach(stop => stop()); };
  }, []);

  useEffect(() => {
    let active = true;
    let fetchId = 0;
    const api = window.electron.cowork;
    setSession(previous => previous?.id === sessionId ? previous : null);
    setFailed(false);
    if (!sessionId) { setLoading(false); return; }
    const load = async () => {
      const request = ++fetchId;
      try {
        const result = await api.getSession(sessionId);
        if (!active || request !== fetchId) return;
        setSession(result.success && result.session ? result.session : null);
        setFailed(!result.success || !result.session);
      } catch {
        if (active && request === fetchId) setFailed(true);
      } finally {
        if (active && request === fetchId) setLoading(false);
      }
    };
    const unsubscribe = [
      api.onStreamMessage(data => {
        if (data.sessionId !== sessionId) return;
        setSession(previous => {
          if (!previous || previous.id !== sessionId) return previous;
          const index = previous.messages.findIndex(message => message.id === data.message.id);
          const messages = [...previous.messages];
          if (index >= 0) messages[index] = data.message;
          else messages.push(data.message);
          return { ...previous, messages };
        });
      }),
      api.onStreamMessageUpdate(data => {
        if (data.sessionId !== sessionId) return;
        setSession(previous => previous?.id === sessionId ? {
          ...previous,
          messages: previous.messages.map(message => message.id === data.messageId
            ? { ...message, content: data.content, metadata: { ...message.metadata, ...data.metadata } }
            : message),
        } : previous);
      }),
      api.onStreamSessionStatus(data => {
        if (data.sessionId !== sessionId) return;
        setSession(previous => previous?.id === sessionId ? { ...previous, status: data.status } : previous);
        if (data.status !== CoworkSessionStatusValue.Running) void load();
      }),
      api.onStreamComplete(data => { if (data.sessionId === sessionId) void load(); }),
      api.onStreamError(data => { if (data.sessionId === sessionId) void load(); }),
      api.onSessionsChanged(() => { void load(); }),
    ];
    loadRef.current = () => { void load(); };
    setLoading(true);
    void load();
    return () => { active = false; loadRef.current = () => undefined; unsubscribe.forEach(stop => stop()); };
  }, [sessionId]);
  useEffect(() => { if (visible) refresh(); }, [visible, refresh]);
  return { session: session?.id === sessionId ? session : null, pending: Object.values(pending).some(id => id === sessionId), failed, loading, refresh };
}
