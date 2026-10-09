import { useCallback, useEffect, useRef, useState } from 'react';

import {
  LanguageTool, LanguageToolCode, LanguageToolEventType, type LanguageToolInput, type LanguageToolQuotas,
  type LanguageToolRequest, SpeechCommand, SpeechStatus, TranslationTarget,
} from '../../../shared/desktopCompanion/languageTools';
import { companionTranslationTarget } from '../../../shared/desktopCompanion/selectionActions';
import { type SpeechPlayback, SpeechQueue } from './speechQueue';

const EMPTY_PLAYBACK: SpeechPlayback = { status: SpeechStatus.Idle, index: 0, total: 0 };

/** Keeps synthesis and playback alive when the small selection card is hidden. */
export function useLanguageTools() {
  const api = window.electron.desktopCompanion;
  const [input, setInput] = useState<LanguageToolInput | null>(null);
  const [target, setTarget] = useState<TranslationTarget>(TranslationTarget.Chinese);
  const [translation, setTranslation] = useState('');
  const [translating, setTranslating] = useState(false);
  const [translationKey, setTranslationKey] = useState('');
  const [error, setError] = useState<number | null>(null);
  const [errorTool, setErrorTool] = useState<LanguageTool | null>(null);
  const [quota, setQuota] = useState<LanguageToolQuotas | null>(null);
  const [playback, setPlayback] = useState<SpeechPlayback>(EMPTY_PLAYBACK);
  const [speechText, setSpeechText] = useState('');
  const [segmentTotal, setSegmentTotal] = useState(0);
  const [rate, setRate] = useState(1);
  const player = useRef<SpeechQueue | null>(null);
  const translationId = useRef<string | null>(null);
  const speechId = useRef<string | null>(null);
  const inputId = useRef<string>();
  const rateRef = useRef(rate);
  rateRef.current = rate;

  const refreshQuota = useCallback(() => {
    void api.getLanguageToolQuota().then(result => {
      if (result.success && result.data) setQuota(result.data);
      else if (result.code === LanguageToolCode.Unauthorized) setError(result.code);
    }).catch(() => setError(LanguageToolCode.Unavailable));
  }, [api]);

  const stopSpeech = useCallback(() => {
    if (speechId.current) void api.abortLanguageTool(speechId.current);
    speechId.current = null;
    player.current?.stop();
    setSegmentTotal(0);
  }, [api]);
  const stopTranslation = useCallback(() => {
    if (translationId.current) void api.abortLanguageTool(translationId.current);
    translationId.current = null;
    setTranslating(false);
  }, [api]);

  const start = useCallback((tool: LanguageTool, text: string, language: TranslationTarget = TranslationTarget.Auto) => {
    if (!text.trim()) return;
    setError(null);
    setErrorTool(null);
    const request: LanguageToolRequest = { requestId: crypto.randomUUID(), tool, text, targetLanguage: language };
    const isTranslation = tool === LanguageTool.Translate;
    if (isTranslation) {
      stopTranslation();
      stopSpeech();
      translationId.current = request.requestId;
      setTranslationKey(request.requestId);
      setTranslation('');
      setTranslating(true);
    } else {
      stopSpeech();
      speechId.current = request.requestId;
      setSpeechText(text);
      player.current?.begin();
      player.current?.setRate(rateRef.current);
    }
    const reject = (code: number) => {
      const active = isTranslation ? translationId : speechId;
      if (active.current !== request.requestId) return;
      active.current = null;
      if (isTranslation) setTranslating(false);
      else player.current?.stop();
      setError(code);
      setErrorTool(tool);
      refreshQuota();
    };
    void api.startLanguageTool(request).then(result => {
      if (!result.success) reject(result.code ?? LanguageToolCode.Unavailable);
    }).catch(() => reject(LanguageToolCode.Unavailable));
  }, [api, refreshQuota, stopSpeech, stopTranslation]);

  useEffect(() => {
    let disposed = false;
    const queue = new SpeechQueue(new Audio(), value => {
      setPlayback(value);
      void api.setSpeechStatus(value.status).catch(() => undefined);
    });
    player.current = queue;
    const receive = (next: LanguageToolInput | null) => {
      if (disposed || !next?.text || next.id === inputId.current) return;
      inputId.current = next.id;
      stopTranslation();
      stopSpeech();
      setTranslation('');
      setInput(next);
      const language = companionTranslationTarget(next.text) === 'en' ? TranslationTarget.English : TranslationTarget.Chinese;
      setTarget(language);
      start(next.tool, next.text, language);
      refreshQuota();
    };
    const offInput = api.onLanguageToolInput(receive);
    void api.getLanguageToolInput().then(receive);
    const offEvents = api.onLanguageToolEvent(event => {
      const isTranslation = event.requestId === translationId.current;
      const isSpeech = event.requestId === speechId.current;
      if (!isTranslation && !isSpeech) return;
      if (event.type === LanguageToolEventType.Delta && isTranslation) setTranslation(value => value + event.text);
      else if (event.type === LanguageToolEventType.Audio && isSpeech) {
        setSegmentTotal(event.total);
        try { queue.append(event.index, event.audioBase64, event.mimeType); }
        catch { stopSpeech(); setError(LanguageToolCode.Upstream); setErrorTool(LanguageTool.Tts); }
      } else if (event.type === LanguageToolEventType.Error) {
        setError(event.code);
        setErrorTool(isSpeech ? LanguageTool.Tts : LanguageTool.Translate);
        if (isTranslation) { translationId.current = null; setTranslating(false); }
        if (isSpeech) { speechId.current = null; queue.finish(); }
        refreshQuota();
      } else if (event.type === LanguageToolEventType.Done) {
        if (isTranslation) { translationId.current = null; setTranslating(false); }
        if (isSpeech) { speechId.current = null; queue.finish(); }
        if (event.quota) setQuota(event.quota);
      }
    });
    const offCommands = api.onSpeechCommand(command => {
      if (command === SpeechCommand.Stop) stopSpeech();
      else if (command === SpeechCommand.Pause) queue.pause();
      else if (command === SpeechCommand.Resume) queue.resume();
    });
    const offReset = api.onLanguageToolsReset(() => {
      stopSpeech(); stopTranslation(); setInput(null); setTranslation(''); setSpeechText(''); setQuota(null);
      setError(null); setErrorTool(null); inputId.current = undefined;
    });
    return () => {
      disposed = true; offInput(); offEvents(); offCommands(); offReset();
      stopTranslation(); stopSpeech(); player.current = null; inputId.current = undefined;
    };
  }, [api, refreshQuota, start, stopSpeech, stopTranslation]);

  const translate = (language = target) => {
    if (!input?.text) return;
    setTarget(language);
    start(LanguageTool.Translate, input.text, language);
  };
  const togglePlayback = () => {
    if (playback.total === 0 && errorTool === LanguageTool.Tts) start(LanguageTool.Tts, speechText);
    else if ([SpeechStatus.Paused, SpeechStatus.Ended, SpeechStatus.Error].some(status => status === playback.status)) player.current?.resume();
    else if (playback.status === SpeechStatus.Idle && input?.text) start(LanguageTool.Tts, input.text);
    else player.current?.pause();
  };
  const changeRate = (value: number) => { setRate(value); player.current?.setRate(value); };
  const retry = () => {
    if (!input?.text) return;
    const tool = errorTool ?? input.tool;
    start(tool, tool === LanguageTool.Tts ? speechText || input.text : input.text, target);
  };

  return {
    input, target, translation, translating, translationKey, translate, stopTranslation, error, retry, quota,
    playback, speechText, segmentTotal, rate, changeRate, togglePlayback, stopSpeech,
    readTranslation: () => start(LanguageTool.Tts, translation),
  };
}
