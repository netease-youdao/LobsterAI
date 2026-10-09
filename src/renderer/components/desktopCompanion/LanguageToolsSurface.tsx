import './languageTools.css';

import {
  ArrowPathIcon, ArrowRightIcon, ArrowTopRightOnSquareIcon, ArrowUpIcon, CheckIcon,
  DocumentDuplicateIcon, LanguageIcon, MinusIcon, PauseIcon, PlayIcon, SpeakerWaveIcon, StopIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import { MapPinIcon } from '@heroicons/react/24/solid';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { type DesktopCompanionState } from '../../../shared/desktopCompanion/constants';
import { LanguageTool, LanguageToolCode, SpeechStatus, TranslationTarget } from '../../../shared/desktopCompanion/languageTools';
import { i18nService } from '../../services/i18n';
import { useLanguageTools } from './useLanguageTools';
import { useMeasuredSurface } from './useMeasuredSurface';
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

export default function LanguageToolsSurface({ state }: { state: DesktopCompanionState }) {
  const api = window.electron.desktopCompanion;
  const tools = useLanguageTools();
  const { input, translation, translating, playback } = tools;
  const followUp = useTranslationFollowUp(`${input?.id ?? ''}:${tools.translationKey}`, input?.text ?? '', translation);
  const [pinned, setPinned] = useState(false);
  const [copied, setCopied] = useState(false);
  const [handoffError, setHandoffError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  useMeasuredSurface(rootRef, !!input, input?.id);

  useEffect(() => { setPinned(false); setCopied(false); setHandoffError(false); }, [input?.id]);
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
  const currentQuota = tools.quota?.tools[input.tool];
  const speechVisible = !isTranslation || playback.status !== SpeechStatus.Idle;
  const canResume = [SpeechStatus.Idle, SpeechStatus.Paused, SpeechStatus.Ended, SpeechStatus.Error].some(value => value === playback.status);
  const total = Math.max(tools.segmentTotal, playback.total);
  const completedSegments = playback.status === SpeechStatus.Ended ? playback.index : Math.max(0, playback.index - 1);

  const toTask = async () => {
    const conversation = [translation, ...followUp.turns.map(turn =>
      t(turn.role === 'user' ? 'desktopToolsQuestion' : 'desktopToolsReply') + ': ' + turn.content)].join('\n\n');
    const prompt = t('desktopCompanionTaskFromSelection').replace('{text}', source).replace('{answer}', conversation);
    try {
      await api.setDraft({ prompt, attachments: [], workingDirectory: state.draft.workingDirectory });
      await api.selectSession(null);
      await api.closeLanguageTool();
      if (!state.panelVisible) await api.togglePanel();
    } catch { setHandoffError(true); }
  };
  const copy = () => {
    void api.copyText(translation).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1_400);
    });
  };

  return (
    <div className="sel-surface">
      <div className="sel-card language-card" ref={rootRef}>
        <header className="sel-header language-header">
          <span className="sel-chip">{isTranslation ? <LanguageIcon /> : <SpeakerWaveIcon />}
            {t(isTranslation ? 'desktopCompanionActionTranslate' : 'desktopToolsReadAloud')}
          </span>
          <span className="sel-source" title={source}>{source}</span>
          <button type="button" className="sel-icon" data-on={pinned}
            title={t(pinned ? 'desktopCompanionAnswerUnpin' : 'desktopCompanionAnswerPin')}
            aria-label={t(pinned ? 'desktopCompanionAnswerUnpin' : 'desktopCompanionAnswerPin')}
            onClick={() => { setPinned(!pinned); void api.pinLanguageTool(!pinned); }}><MapPinIcon /></button>
          <button type="button" className="sel-icon" title={t('desktopToolsClose')} aria-label={t('desktopToolsClose')}
            onClick={() => { void api.closeLanguageTool(); }}><XMarkIcon /></button>
        </header>

        <div className="language-scroll" ref={conversationRef}>
          {isTranslation ? <>
            <div className="language-direction">
              <span>{t('desktopToolsDetectLanguage')}</span><ArrowRightIcon />
              <select aria-label={t('desktopToolsTarget')} value={tools.target}
                onChange={event => tools.translate(event.target.value as TranslationTarget)}>
                <option value={TranslationTarget.Chinese}>{t('desktopToolsChinese')}</option>
                <option value={TranslationTarget.English}>{t('desktopToolsEnglish')}</option>
              </select>
            </div>
            <div className="language-translation" aria-live="polite">
              {translation || (translating ? <span className="sel-thinking"><span className="sel-dots"><i /><i /><i /></span>{t('desktopToolsTranslating')}</span> : null)}
              {translating && translation && <span className="sel-caret" />}
            </div>
            <div className="language-result-actions">
              <button type="button" className="sel-icon" disabled={!translation} onClick={copy}
                title={t(copied ? 'desktopCompanionSelectionCopied' : 'desktopCompanionSelectionCopy')}
                aria-label={t(copied ? 'desktopCompanionSelectionCopied' : 'desktopCompanionSelectionCopy')}>
                {copied ? <CheckIcon /> : <DocumentDuplicateIcon />}
              </button>
              <button type="button" className="sel-icon" onClick={() => translating ? tools.stopTranslation() : tools.translate()}
                title={t(translating ? 'desktopToolsStop' : 'desktopToolsRetranslate')}
                aria-label={t(translating ? 'desktopToolsStop' : 'desktopToolsRetranslate')}>
                {translating ? <StopIcon /> : <ArrowPathIcon />}
              </button>
              <button type="button" className="sel-icon" disabled={!translation || translating} onClick={tools.readTranslation}
                title={t('desktopToolsReadTranslation')} aria-label={t('desktopToolsReadTranslation')}><SpeakerWaveIcon /></button>
              <button type="button" className="language-to-task" disabled={!translation || translating || !!followUp.streaming}
                onClick={() => { void toTask(); }}><ArrowTopRightOnSquareIcon />{t('desktopCompanionAnswerToTask')}</button>
            </div>
          </> : <div className="language-source-preview"><span>{t('desktopToolsInput')}</span><p>{source}</p></div>}

          {speechVisible && <section className="language-player" aria-label={t('desktopToolsPlayback')}>
            <div className="language-playback-state">
              <span className="language-wave" data-playing={playback.status === SpeechStatus.Playing} aria-hidden="true"><i /><i /><i /><i /><i /></span>
              <strong aria-live="polite">{t(STATUS_KEYS[playback.status])}</strong>
              <small>{total > 0 ? t('desktopToolsSegmentProgress').replace('{current}', String(playback.index)).replace('{total}', String(total))
                : [...(tools.speechText || source)].length.toLocaleString() + t('desktopToolsCharacters')}</small>
            </div>
            {total > 0 && <progress className="language-progress" value={completedSegments} max={total} aria-label={t('desktopToolsSegmentLabel')} />}
            <div className="language-player-actions">
              <button type="button" className="language-play" onClick={tools.togglePlayback}
                aria-label={t(playback.status === SpeechStatus.Idle ? 'desktopToolsReadAloud' : canResume ? 'desktopToolsResume' : 'desktopToolsPause')}>
                {canResume ? <PlayIcon /> : <PauseIcon />}
              </button>
              <button type="button" className="sel-icon" disabled={playback.status === SpeechStatus.Idle} onClick={tools.stopSpeech}
                title={t('desktopToolsStop')} aria-label={t('desktopToolsStop')}><StopIcon /></button>
              <select aria-label={t('desktopToolsSpeed')} value={tools.rate} onChange={event => tools.changeRate(Number(event.target.value))}>
                {[0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
              </select>
              <button type="button" className="language-hide" onClick={() => { void api.hideLanguageTool(); }}
                title={t('desktopToolsMinimize')}><MinusIcon />{t('desktopToolsBackground')}</button>
            </div>
          </section>}

          {tools.error !== null && <div className="sel-error language-error" role="alert">
            {t(ERROR_KEYS[tools.error] ?? 'desktopToolsUpstream')}
            {tools.error === LanguageToolCode.Unauthorized
              ? <button type="button" onClick={() => { void window.electron.auth.login(); }}>{t('desktopToolsLogin')}</button>
              : <button type="button" onClick={tools.retry}><ArrowPathIcon />{t('desktopCompanionAnswerRetry')}</button>}
          </div>}
          {isTranslation && <div className="language-conversation">
            {followUp.turns.map((turn, index) => turn.role === 'user'
              ? <p className="sel-question" key={index}>{turn.content}</p>
              : <div className="sel-markdown" key={index}><FollowUpAnswer text={turn.content} /></div>)}
            {followUp.streaming && <div className="sel-markdown" aria-live="polite">
              <FollowUpAnswer text={followUp.streaming.text || t('desktopCompanionAnswerThinking')} /><span className="sel-caret" />
            </div>}
            {followUp.error && <p className="sel-error" role="alert">{followUp.error}
              <button type="button" onClick={followUp.retry}><ArrowPathIcon />{t('desktopCompanionAnswerRetry')}</button>
            </p>}
            {handoffError && <p className="sel-error" role="alert">{t('desktopCompanionRequestFailed')}</p>}
          </div>}
        </div>

        {isTranslation && <footer className="sel-footer language-follow-up">
          <form className="sel-ask" onSubmit={event => { event.preventDefault(); followUp.submit(); }}>
            <input value={followUp.question} onChange={event => followUp.setQuestion(event.target.value)} maxLength={4_000}
              onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}
              aria-label={t('desktopCompanionAnswerFollowUp')} placeholder={t('desktopCompanionAnswerFollowUp')}
              disabled={!translation || translating} />
            {followUp.streaming
              ? <button type="button" className="sel-send" aria-label={t('desktopToolsStop')} onClick={followUp.stop}><StopIcon /></button>
              : <button type="submit" className="sel-send" disabled={!translation || translating || !followUp.question.trim()}
                aria-label={t('desktopCompanionSend')}><ArrowUpIcon /></button>}
          </form>
        </footer>}
        <div className="language-quota" title={t('desktopToolsResetTime')}>
          {currentQuota ? <>
            <span>{t('desktopToolsRemaining').replace('{count}', String(currentQuota.remainingRequests))}</span>
            {currentQuota.remainingCharacters !== null && <span>{t('desktopToolsRemainingCharacters').replace('{count}', currentQuota.remainingCharacters.toLocaleString())}</span>}
          </> : <span>{t('desktopToolsQuotaHint')}</span>}
        </div>
      </div>
    </div>
  );
}

function FollowUpAnswer({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href} onClick={event => {
      event.preventDefault(); if (href) void window.electron.shell.openExternal(href);
    }}>{children}</a>,
  }}>{text}</ReactMarkdown>;
}
