import { useCallback, useEffect, useRef, useState } from 'react';

import { CompanionQuickAnswerErrorCode, CompanionQuickAnswerEventType, type CompanionQuickAnswerTurn } from '../../../shared/desktopCompanion/constants';
import { CompanionSelectionAction } from '../../../shared/desktopCompanion/selectionActions';
import { i18nService } from '../../services/i18n';

interface Streaming { requestId: string; text: string }

/** Uses the same quick-answer conversation and task handoff as the selection Ask action. */
export function useTranslationFollowUp(key: string, source: string, translation: string) {
  const api = window.electron.desktopCompanion;
  const [turns, setTurns] = useState<CompanionQuickAnswerTurn[]>([]);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [error, setError] = useState('');
  // Kept with the conversation it belongs to: the reset effect runs a render late, and the card a
  // sign-in reopens must not flash the old prompt (and count it as shown again) in that render.
  const [loginRequiredKey, setLoginRequiredKey] = useState<string | null>(null);
  const loginRequired = loginRequiredKey === key;
  const [question, setQuestion] = useState('');
  const streamRef = useRef<Streaming | null>(null);
  const stop = useCallback(() => {
    if (streamRef.current) void api.abortQuickAnswer(streamRef.current.requestId);
    streamRef.current = null;
    setStreaming(null);
  }, [api]);

  useEffect(() => {
    stop(); setTurns([]); setError(''); setQuestion(''); setLoginRequiredKey(null);
    return stop;
  }, [key, stop]);
  useEffect(() => api.onQuickAnswer(event => {
    const current = streamRef.current;
    if (!current || event.requestId !== current.requestId) return;
    if (event.type === CompanionQuickAnswerEventType.Delta) {
      streamRef.current = { ...current, text: current.text + event.text };
      setStreaming(streamRef.current);
    } else {
      if (event.type === CompanionQuickAnswerEventType.Done && current.text.trim()) {
        setTurns(previous => [...previous, { role: 'assistant', content: current.text }]);
      } else if (event.type === CompanionQuickAnswerEventType.Error) setError(event.message);
      streamRef.current = null; setStreaming(null);
    }
  }), [api]);

  const ask = (history: CompanionQuickAnswerTurn[]) => {
    const requestId = crypto.randomUUID();
    streamRef.current = { requestId, text: '' };
    setStreaming(streamRef.current); setError(''); setLoginRequiredKey(null);
    const fail = (message?: string) => {
      if (streamRef.current?.requestId !== requestId) return;
      streamRef.current = null; setStreaming(null);
      setError(message || i18nService.t('desktopCompanionRequestFailed'));
    };
    void api.startQuickAnswer({ requestId, action: CompanionSelectionAction.Ask, text: source,
      history: [{ role: 'assistant', content: translation }, ...history] }).then(result => {
      if (!result.success && streamRef.current?.requestId === requestId) {
        setLoginRequiredKey(result.code === CompanionQuickAnswerErrorCode.LoginRequired ? key : null);
        fail(result.error);
      }
    }).catch(() => fail());
  };
  /** Asks a follow-up about the finished translation; returns whether it went out. */
  const send = (text: string): boolean => {
    const content = text.trim();
    if (!content || !translation || streamRef.current) return false;
    const history: CompanionQuickAnswerTurn[] = [...turns, { role: 'user', content }];
    setTurns(history); ask(history);
    return true;
  };
  const submit = () => { if (send(question)) setQuestion(''); };
  // The question a sign-in interrupted: it is the newest turn and still has no answer.
  const pendingQuestion = loginRequired && turns[turns.length - 1]?.role === 'user' ? turns[turns.length - 1].content : undefined;
  return { turns, streaming, error, loginRequired, pendingQuestion, question, setQuestion, send, submit, stop, retry: () => ask(turns) };
}
