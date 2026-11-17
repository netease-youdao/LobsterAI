import { useCallback, useEffect, useRef, useState } from 'react';

import type { CoworkMessageEditPending } from '../../../shared/cowork/messageEdit';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { store } from '../../store';
import type { CoworkMessage, CoworkSession } from '../../types/cowork';

export function useUserMessageEdit(session: CoworkSession | null, disabled: boolean) {
  const sessionId = session?.id;
  const currentId = useRef(sessionId);
  const operationGeneration = useRef(0);
  currentId.current = sessionId;
  const [editing, setEditing] = useState<{ sessionId: string; message: CoworkMessage; initialPrompt?: string; initialRemovedImageIndexes?: number[] } | null>(null);
  const [pending, setPending] = useState<CoworkMessageEditPending>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const editingMessageId = useRef<string | undefined>(undefined);
  editingMessageId.current = editing?.message.id;

  useEffect(() => {
    const generation = ++operationGeneration.current;
    setPending(undefined); setError(undefined); setBusy(false);
    if (!sessionId) return;
    let cancelled = false;
    void window.electron.cowork.getMessageEdit(sessionId).then(result => {
      if (!cancelled && operationGeneration.current === generation) setPending(result.pending);
    }).catch(() => { if (!cancelled) setError(i18nService.t('coworkEditRecoveryFailed')); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const begin = useCallback((message: CoworkMessage) => {
    if (!sessionId || disabled || busy || pending) return;
    setEditing({ sessionId, message }); setError(undefined);
    // Report an unusable attachment before the user rewrites the message, not after.
    const generation = operationGeneration.current;
    void window.electron.cowork.checkMessageEdit({ sessionId, messageId: message.id }).then(result => {
      if (result.success || currentId.current !== sessionId || operationGeneration.current !== generation) return;
      if (editingMessageId.current === message.id) setError(result.error ?? i18nService.t('coworkEditUnsupported'));
    }).catch(() => { /* The send path reports the same problem. */ });
  }, [sessionId, disabled, busy, pending]);

  const submit = useCallback(async (prompt: string, removedImageIndexes: number[]) => {
    if (!editing || editing.sessionId !== sessionId || busy || disabled || pending) return;
    operationGeneration.current += 1;
    setBusy(true); setError(undefined);
    try {
      const result = await coworkService.editMessage({ sessionId: editing.sessionId, messageId: editing.message.id, prompt, removedImageIndexes });
      if (currentId.current !== sessionId) return;
      setPending(result.pending);
      if (result.success) setEditing(null);
      else setError(result.error ?? i18nService.t('coworkEditFailed'));
    } catch {
      if (currentId.current === sessionId) {
        setError(i18nService.t('coworkEditRecoveryFailed'));
        const result = await window.electron.cowork.getMessageEdit(editing.sessionId).catch(() => null);
        if (currentId.current === sessionId) setPending(result?.pending);
      }
    } finally {
      if (currentId.current === sessionId) setBusy(false);
    }
  }, [editing, sessionId, busy, disabled, pending]);

  const recover = useCallback(async () => {
    if (!sessionId || !pending || busy) return;
    operationGeneration.current += 1;
    setBusy(true); setError(undefined);
    try {
      const result = await coworkService.recoverMessageEdit(sessionId, pending.operationId);
      if (currentId.current !== sessionId) return;
      if (result.success) {
        const rail = await coworkService.loadSessionMessageRailIndex(sessionId);
        const restoredIndex = rail.find(item => item.messageId === pending.messageId)?.messageOffset;
        if (restoredIndex !== undefined) await coworkService.loadMessageWindowAroundIndex(sessionId, restoredIndex);
        if (currentId.current !== sessionId) return;
        const restoredMessage = store.getState().cowork.currentSession?.messages.find(message => message.id === pending.messageId);
        setPending(undefined);
        setEditing(restoredMessage ? { sessionId, message: restoredMessage, initialPrompt: pending.prompt,
          initialRemovedImageIndexes: pending.removedImageIndexes } : null);
      }
      else { setPending(result.pending ?? pending); setError(result.error); }
    } catch {
      if (currentId.current === sessionId) setError(i18nService.t('coworkEditRecoveryFailed'));
    } finally {
      if (currentId.current === sessionId) setBusy(false);
    }
  }, [sessionId, pending, busy]);

  /** Resolves to whether another version is now shown. */
  const switchVersion = useCallback(async (message: CoworkMessage, targetIndex: number): Promise<boolean> => {
    if (!sessionId || disabled || busy || pending || editing) return false;
    operationGeneration.current += 1;
    setBusy(true);
    try {
      return (await coworkService.switchMessageVersion({ sessionId, messageId: message.id, targetIndex })).success;
    } finally {
      if (currentId.current === sessionId) setBusy(false);
    }
  }, [sessionId, disabled, busy, pending, editing]);

  return {
    editing: editing?.sessionId === sessionId ? editing : null,
    pending, busy, error, begin, submit, recover, switchVersion,
    cancel: () => { if (!busy && !pending) { setEditing(null); setError(undefined); } },
  };
}
