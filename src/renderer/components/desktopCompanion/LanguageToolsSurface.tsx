import './languageTools.css';

import { PauseIcon, PlayIcon } from '@heroicons/react/16/solid';
import {
  ArrowPathIcon, ArrowRightIcon, ArrowUpRightIcon, CheckIcon, ChevronDownIcon, Square2StackIcon,
} from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';

import { type DesktopCompanionState } from '../../../shared/desktopCompanion/constants';
import { LanguageTool, LanguageToolCode, SpeechStatus, TranslationTarget } from '../../../shared/desktopCompanion/languageTools';
import { CompanionSelectionAction } from '../../../shared/desktopCompanion/selectionActions';
import { i18nService } from '../../services/i18n';
import {
  SelectionAnswer,
  SelectionCardHeader,
  SelectionComposer,
  SelectionError,
  SelectionThinking,
  SourceQuote,
  StopGlyph,
} from './SelectionCard';
import SelectionLoginRequired from './SelectionLoginRequired';
import { useLanguageTools } from './useLanguageTools';
import { useMeasuredSurface } from './useMeasuredSurface';
import { usePointerPassThrough } from './usePointerPassThrough';
import { useTranslationFollowUp } from './useTranslationFollowUp';

const t = (key: string) => i18nService.t(key);
const ERROR_KEYS: Record<number, string> = {
  [LanguageToolCode.Unauthorized]: 'desktopToolsLoginRequired', [LanguageToolCode.Unavailable]: 'desktopToolsUnavailable',
  [LanguageToolCode.InvalidInput]: 'desktopToolsInvalidInput', [LanguageToolCode.TooLong]: 'desktopToolsTooLong',
  [LanguageToolCode.DailyLimit]: 'desktopToolsDailyLimit', [LanguageToolCode.RateLimit]: 'desktopToolsRateLimit',
  [LanguageToolCode.Duplicate]: 'desktopToolsDuplicate', [LanguageToolCode.Upstream]: 'desktopToolsUpstream',
};
const STATUS_KEYS: Record<SpeechStatus, string> = {
  [SpeechStatus.Idle]: 'desktopToolsReady', [SpeechStatus.Loading]: 'desktopToolsPreparing',
  [SpeechStatus.Playing]: 'desktopToolsPlaying', [SpeechStatus.Paused]: 'desktopToolsPaused',
  [SpeechStatus.Ended]: 'desktopToolsFinished', [SpeechStatus.Error]: 'desktopToolsAudioError',
};
const RATES = [0.75, 1, 1.25, 1.5, 2];

export default function LanguageToolsSurface({ state }: { state: DesktopCompanionState }) {
  const api = window.electron.desktopCompanion;
  const tools = useLanguageTools();
  const { input, translation, translating, playback } = tools;
  const followUp = useTranslationFollowUp(`${input?.id ?? ''}:${tools.translationKey}`, input?.text ?? '', translation);
  const [pinned, setPinned] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [handoffError, setHandoffError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  useMeasuredSurface(rootRef, !!input, input?.id);
  usePointerPassThrough(input?.id, api.setLanguageToolPassThrough);

  useEffect(() => { setPinned(false); setCopied(false); setCopyError(''); setHandoffError(false); }, [input?.id]);
  // Dragging the card pins it in the main process.
  useEffect(() => api.onLanguageToolPinned(value => setPinned(value)), [api]);
  useEffect(() => {
    document.title = t(input?.tool === LanguageTool.Tts ? 'desktopToolsReadAloud' : 'desktopCompanionActionTranslate');
  }, [input?.tool]);
  useEffect(() => {
    if (!followUp.turns.length) return;
    const body = conversationRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [followUp.streaming?.text, followUp.turns.length]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) void api.closeLanguageTool();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [api]);

  if (!input?.text) return null;
  const source = input.text;
  const isTranslation = input.tool === LanguageTool.Translate;
  const loginRequired = tools.error === LanguageToolCode.Unauthorized || followUp.loginRequired;
  const translationLoginRequired = tools.error === LanguageToolCode.Unauthorized && tools.errorTool === LanguageTool.Translate;
  const speechVisible = !isTranslation || playback.status !== SpeechStatus.Idle;
  const speechActive = playback.status !== SpeechStatus.Idle;
  const speechLoading = playback.status === SpeechStatus.Loading;
  const canReplay = playback.status === SpeechStatus.Ended || playback.status === SpeechStatus.Error;
  const canResume = [SpeechStatus.Idle, SpeechStatus.Paused, SpeechStatus.Ended, SpeechStatus.Error].some(value => value === playback.status);
  const total = Math.max(tools.segmentTotal, playback.total);
  const completedSegments = playback.completed;
  const progress = total > 0 ? Math.round((completedSegments / total) * 100) : 0;

  const toTask = async () => {
    try {
      await api.setDraft({
        ...state.draft,
        selectionContext: {
          id: crypto.randomUUID(), action: CompanionSelectionAction.Translate, sourceText: source,
          turns: [{ role: 'assistant', content: translation }, ...followUp.turns],
        },
      });
      await api.selectSession(null);
      await api.closeLanguageTool();
      if (!state.panelVisible) await api.togglePanel();
    } catch { setHandoffError(true); }
  };
  const copy = () => {
    setCopied(false);
    setCopyError('');
    void api.copyText(translation).then(result => {
      if (!result.success) { setCopyError(result.error); return; }
      setCopied(true); setTimeout(() => setCopied(false), 1_400);
    }).catch(() => setCopyError(t('desktopCompanionCopyFailed')));
  };
  const playLabel = t(canReplay ? 'desktopToolsReplay'
    : playback.status === SpeechStatus.Idle ? 'desktopToolsReadAloud' : canResume ? 'desktopToolsResume' : 'desktopToolsPause');
  const progressLabel = t('desktopToolsSegmentProgress')
    .replace('{current}', String(completedSegments)).replace('{total}', String(total));

  return (
    <div className="sel-surface">
      <div className="sel-card" ref={rootRef} data-tool={input.tool} style={{ maxHeight: input.cardMaxHeight }}>
        <SelectionCardHeader
          title={t(isTranslation ? 'desktopCompanionActionTranslate' : 'desktopToolsReadAloud')}
          pinned={pinned}
          onPin={() => { setPinned(!pinned); void api.pinLanguageTool(!pinned); }}
          onClose={() => { void api.closeLanguageTool(); }}
          closeLabel={t('desktopToolsClose')}
        />

        {isTranslation && (
          <div className="lt-langs">
            <span className="lt-lang">{t('desktopToolsDetectLanguage')}</span>
            <ArrowRightIcon className="lt-arrow" aria-hidden="true" />
            <label className="lt-lang lt-select">
              <select aria-label={t('desktopToolsTarget')} value={tools.target} disabled={translationLoginRequired}
                onChange={event => tools.translate(event.target.value as TranslationTarget)}>
                <option value={TranslationTarget.Chinese}>{t('desktopToolsChinese')}</option>
                <option value={TranslationTarget.English}>{t('desktopToolsEnglish')}</option>
              </select>
              <ChevronDownIcon aria-hidden="true" />
            </label>
          </div>
        )}

        <div className="sel-scroll" ref={conversationRef}>
          {copyError && <SelectionError message={copyError} />}
          {!isTranslation && <SourceQuote key={input.id} text={source} lines={4} />}

          {isTranslation && (
            <div className="lt-translation" aria-live="polite">
              {translation
                ? <>{translation}{translating && <span className="sel-caret" />}</>
                : translating && <SelectionThinking label={t('desktopToolsTranslating')} />}
            </div>
          )}

          {loginRequired && <SelectionLoginRequired />}
          {tools.error !== null && tools.error !== LanguageToolCode.Unauthorized && (
            <SelectionError
              message={t(tools.error === LanguageToolCode.DailyLimit && tools.errorTool === LanguageTool.Translate
                ? 'desktopToolsTranslationDailyLimit' : ERROR_KEYS[tools.error] ?? 'desktopToolsUpstream')}
              action={<button type="button" onClick={tools.retry}>{t('desktopCompanionAnswerRetry')}</button>}
            />
          )}

          {isTranslation && (
            <div className="lt-conversation">
              {followUp.turns.map((turn, index) => turn.role === 'user'
                ? <p className="sel-question" key={index}>{turn.content}</p>
                : <SelectionAnswer key={index} text={turn.content} />)}
              {followUp.streaming && (followUp.streaming.text
                ? <SelectionAnswer text={followUp.streaming.text} streaming />
                : <SelectionThinking label={t('desktopCompanionAnswerThinking')} />)}
              {followUp.error && !loginRequired && (
                <SelectionError
                  message={followUp.error}
                  action={<button type="button" onClick={followUp.retry}>{t('desktopCompanionAnswerRetry')}</button>}
                />
              )}
              {handoffError && <SelectionError message={t('desktopCompanionRequestFailed')} />}
            </div>
          )}
        </div>

        {speechVisible && !loginRequired && (
          <section className="lt-player" aria-label={t('desktopToolsPlayback')}>
            <div className="lt-controls">
              <button type="button" className="lt-play" onClick={tools.togglePlayback}
                title={playLabel} aria-label={playLabel}>
                {speechLoading ? <span className="lt-loading-icon" aria-hidden="true"><span className="lt-spinner" /><PauseIcon /></span>
                  : canReplay ? <ArrowPathIcon /> : canResume ? <PlayIcon /> : <PauseIcon />}
              </button>
              <div className="lt-track">
                <div className="lt-status">
                  <strong role="status">{t(STATUS_KEYS[playback.status])}</strong>
                  {playback.status === SpeechStatus.Playing && (
                    <span className="lt-wave" aria-hidden="true"><i /><i /><i /><i /></span>
                  )}
                </div>
                <span className="lt-meta">{[...(tools.speechText || source)].length.toLocaleString() + t('desktopToolsCharacters')}</span>
              </div>
              <label className="lt-rate" title={t('desktopToolsSpeed')}>
                <select aria-label={t('desktopToolsSpeed')} value={tools.rate} onChange={event => tools.changeRate(Number(event.target.value))}>
                  {RATES.map(value => <option key={value} value={value}>{value}×</option>)}
                </select>
                <ChevronDownIcon aria-hidden="true" />
              </label>
              <button type="button" className="sel-icon lt-stop" disabled={!speechActive || playback.status === SpeechStatus.Ended}
                onClick={tools.stopSpeech} title={t('desktopToolsStop')} aria-label={t('desktopToolsStop')}>
                <StopGlyph />
              </button>
            </div>
            <div className="lt-timeline">
              <div className="lt-progress" data-loading={speechLoading} role="progressbar" aria-label={t('desktopToolsSegmentLabel')}
                aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={speechLoading && total === 0 ? undefined : completedSegments}
                aria-valuetext={total > 0 ? progressLabel : t(STATUS_KEYS[playback.status])}>
                <i style={{ width: `${progress}%` }} />
              </div>
              {total > 0 && <span className="lt-progress-label">{progressLabel}</span>}
            </div>
          </section>
        )}

        {isTranslation && !translationLoginRequired && (translating || (translation && !followUp.streaming)) && (
          <div className="sel-actions">
            {translating ? (
              <button type="button" className="sel-action" onClick={tools.stopTranslation}>
                <StopGlyph />{t('desktopToolsStop')}
              </button>
            ) : (
              <>
                <button type="button" className="sel-icon" data-done={copied} onClick={copy}
                  title={t(copied ? 'desktopCompanionSelectionCopied' : 'desktopCompanionSelectionCopy')}
                  aria-label={t(copied ? 'desktopCompanionSelectionCopied' : 'desktopCompanionSelectionCopy')}>
                  {copied ? <CheckIcon /> : <Square2StackIcon />}
                </button>
                <button type="button" className="sel-icon" onClick={() => tools.translate()}
                  title={t('desktopToolsRetranslate')} aria-label={t('desktopToolsRetranslate')}>
                  <ArrowPathIcon />
                </button>
                <button type="button" className="sel-action sel-action-end" onClick={() => { void toTask(); }}>
                  {t('desktopCompanionAnswerToTask')}<ArrowUpRightIcon />
                </button>
              </>
            )}
          </div>
        )}

        {isTranslation && (
          <SelectionComposer
            value={followUp.question}
            placeholder={t('desktopCompanionAnswerFollowUp')}
            onChange={followUp.setQuestion}
            onSubmit={followUp.submit}
            onStop={followUp.streaming ? followUp.stop : undefined}
            disabled={loginRequired || !translation || translating}
          />
        )}
      </div>
    </div>
  );
}
