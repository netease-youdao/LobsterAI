import { ArrowPathIcon,XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback,useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { CoworkMessage, CoworkSession } from '../../types/cowork';
import AssistantTurnBlock from '../cowork/AssistantTurnBlock';
import {
  buildConversationTurns,
  buildDisplayItems,
} from '../cowork/messageDisplayUtils';
import UserMessageItem from '../cowork/UserMessageItem';
import { formatDateTime, stripCronMetadataPrefix } from './utils';

interface RunSessionModalProps {
  /** Task name shown as the modal title instead of the raw session key. */
  taskName?: string | null;
  /** ISO start time of the run being viewed, shown under the title. */
  runStartedAt?: string | null;
  sessionId?: string | null;
  sessionKey?: string | null;
  runSummary?: string | null;
  runError?: string | null;
  onClose: () => void;
}

/**
 * Display-only cleanup of a cron run transcript: strip the machine-routing
 * "[cron:...]" prefix from user prompts and drop back-to-back duplicates of
 * the same prompt (the wake message can be recorded twice by the gateway).
 */
function cleanRunMessages(messages: CoworkMessage[]): CoworkMessage[] {
  const cleaned: CoworkMessage[] = [];
  let previousUserText: string | null = null;
  for (const message of messages) {
    if (message.type !== 'user') {
      cleaned.push(message);
      previousUserText = null;
      continue;
    }
    const content = stripCronMetadataPrefix(message.content ?? '');
    const normalized = content.trim();
    if (previousUserText !== null && normalized === previousUserText) {
      continue;
    }
    previousUserText = normalized;
    cleaned.push(content === message.content ? message : { ...message, content });
  }
  return cleaned;
}

const MAX_RETRIES = 5;
const RETRY_INTERVAL_MS = 3000;

const RunSessionModal: React.FC<RunSessionModalProps> = ({
  taskName,
  runStartedAt,
  sessionId,
  sessionKey,
  runSummary,
  runError,
  onClose,
}) => {
  const [session, setSession] = useState<CoworkSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const runFallbackContent = useMemo(
    () => runSummary?.trim() || runError?.trim() || '',
    [runError, runSummary],
  );

  const loadSession = useCallback(async (isRetry = false): Promise<boolean> => {
    if (!isRetry) {
      setLoading(true);
      setError(null);
    }

    try {
      let loadedSession: CoworkSession | null = null;

      // 1. Try loading by local session ID first
      if (sessionId) {
        const result = await window.electron?.cowork?.getSession(sessionId);
        if (result?.success && result.session) {
          const s = result.session;
          loadedSession = {
            ...s,
            messagesOffset: s.messagesOffset ?? 0,
            totalMessages: s.totalMessages ?? s.messages?.length ?? 0,
          };
        }
      }

      // 2. If not found locally, try resolving via OpenClaw sessionKey
      if (!loadedSession && sessionKey) {
        const result = await window.electron?.scheduledTasks?.resolveSession({
          sessionId,
          sessionKey,
        });
        if (result?.success && result.session) {
          const s = result.session;
          loadedSession = {
            ...s,
            messagesOffset: s.messagesOffset ?? 0,
            totalMessages: s.totalMessages ?? s.messages?.length ?? 0,
          };
        }
      }

      if (cancelledRef.current) return false;

      if (loadedSession) {
        setSession(loadedSession);
        setLoading(false);
        setError(null);
        return true;
      }
      if (runFallbackContent) {
        setSession(null);
        setLoading(false);
        setError(null);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [runFallbackContent, sessionId, sessionKey]);

  useEffect(() => {
    cancelledRef.current = false;

    const run = async () => {
      const success = await loadSession();
      if (cancelledRef.current) return;

      if (!success) {
        // Start polling retries
        setRetryCount(1);
      }
    };

    run();

    return () => {
      cancelledRef.current = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [loadSession]);

  // Polling retry effect
  useEffect(() => {
    if (retryCount === 0 || retryCount > MAX_RETRIES || session) return;

    retryTimerRef.current = setTimeout(async () => {
      if (cancelledRef.current) return;
      const success = await loadSession(true);
      if (cancelledRef.current) return;

      if (!success) {
        if (retryCount >= MAX_RETRIES) {
          setLoading(false);
          setError(i18nService.t('scheduledTasksSessionNotSynced'));
        } else {
          setRetryCount(prev => prev + 1);
        }
      }
    }, RETRY_INTERVAL_MS);

    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [retryCount, session, loadSession]);

  const handleManualRetry = async () => {
    setError(null);
    setLoading(true);
    setRetryCount(0);
    const success = await loadSession();
    if (!success) {
      setRetryCount(1);
    }
  };

  const cleanedMessages = useMemo(
    () => cleanRunMessages(session?.messages ?? []),
    [session?.messages],
  );
  const displayItems = useMemo(() => buildDisplayItems(cleanedMessages), [cleanedMessages]);
  const turns = useMemo(() => buildConversationTurns(displayItems), [displayItems]);

  const runTimeLabel = useMemo(() => {
    if (!runStartedAt) return null;
    const date = new Date(runStartedAt);
    return Number.isFinite(date.getTime()) ? formatDateTime(date) : null;
  }, [runStartedAt]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />

      {/* Modal */}
      <div
        className="relative w-full max-w-3xl mx-4 max-h-[80vh] flex flex-col rounded-2xl shadow-2xl bg-background border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border-subtle bg-surface/50 shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground truncate">
              {taskName?.trim() || session?.title || i18nService.t('scheduledTasksViewSession')}
            </h3>
            {runTimeLabel && (
              <p className="mt-0.5 text-xs text-secondary">
                {i18nService.t('scheduledTasksRunAtTime').replace('{time}', runTimeLabel)}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 p-1 rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <svg className="w-5 h-5 animate-spin text-secondary" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
              </svg>
              <span className="text-sm text-secondary">
                {retryCount > 0
                  ? `${i18nService.t('scheduledTasksSessionSyncing')} (${retryCount}/${MAX_RETRIES})`
                  : i18nService.t('loading')}
              </span>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <span className="text-sm text-secondary">{error}</span>
              <button
                type="button"
                onClick={handleManualRetry}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-primary hover:bg-surface-raised transition-colors"
              >
                <ArrowPathIcon className="w-3.5 h-3.5" />
                {i18nService.t('scheduledTasksSessionRetry')}
              </button>
            </div>
          )}

          {!loading && !error && turns.length === 0 && runFallbackContent && (
            <div className="px-10 py-8">
              <div className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">
                {runFallbackContent}
              </div>
            </div>
          )}

          {!loading && !error && turns.length === 0 && !runFallbackContent && (
            <div className="flex items-center justify-center py-16">
              <span className="text-sm text-secondary">
                {i18nService.t('scheduledTasksNoRuns')}
              </span>
            </div>
          )}

          {!loading && !error && turns.length > 0 && (
            <div className="py-2">
              {turns.map((turn) => {
                const showAssistantBlock = turn.assistantItems.length > 0;

                return (
                  <React.Fragment key={turn.id}>
                    {turn.userMessage && (
                      <UserMessageItem message={turn.userMessage} skills={[]} />
                    )}
                    {showAssistantBlock && (
                      <AssistantTurnBlock
                        turn={turn}
                        showTypingIndicator={false}
                        showCopyButtons={true}
                      />
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default RunSessionModal;
