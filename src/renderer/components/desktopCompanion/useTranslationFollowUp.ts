import { useCallback, useEffect, useRef, useState } from 'react';

import { CompanionQuickAnswerEventType, type CompanionQuickAnswerTurn } from '../../../shared/desktopCompanion/constants';
import { CompanionSelectionAction } from '../../../shared/desktopCompanion/selectionActions';
import { i18nService } from '../../services/i18n';

interface Streaming { requestId: string; text: string }

/** Uses the same quick-answer conversation and task handoff as the selection Ask action. */
export function useTranslationFollowUp(key: string, source: string, translation: string) {
  const api = window.electron.desktopCompanion;
  const [turns, setTurns] = useState<CompanionQuickAnswerTurn[]>([]);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const streamRef = useRef<Streaming | null>(null);
  const stop = useCallback(() => {
    if (streamRef.current) void api.abortQuickAnswer(streamRef.current.requestId);
    streamRef.current = null;
    setStreaming(null);
  }, [api]);

  useEffect(() => {
    stop(); setTurns([]); setError(''); setQuestion('');
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
    setStreaming(streamRef.current); setError('');
    const fail = (message?: string) => {
      if (streamRef.current?.requestId !== requestId) return;
      streamRef.current = null; setStreaming(null);
      setError(message || i18nService.t('desktopCompanionRequestFailed'));
    };
    void api.startQuickAnswer({ requestId, action: CompanionSelectionAction.Ask, text: source,
      history: [{ role: 'assistant', content: translation }, ...history] }).then(result => {
      if (!result.success) fail(result.error);
    }).catch(() => fail());
  };
  const submit = () => {
    if (!question.trim() || !translation || streamRef.current) return;
    const history: CompanionQuickAnswerTurn[] = [...turns, { role: 'user', content: question.trim() }];
    setQuestion(''); setTurns(history); ask(history);
  };
  return { turns, streaming, error, question, setQuestion, submit, stop, retry: () => ask(turns) };
}
