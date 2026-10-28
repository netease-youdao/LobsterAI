import React, { useCallback, useEffect, useMemo, useState } from 'react';

import dreamingLobsterSrc from '../../assets/dreaming-lobster.png';
import { i18nService } from '../../services/i18n';
import type { DreamDiaryData, DreamingEntry, DreamingPhaseInfo, DreamingStatusData } from '../../types/cowork';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_ITEM_TITLE_TEXT,
  SETTINGS_META_TEXT,
} from '../settings/settingsTypography';

interface DreamingSettingsSectionProps {
  dreamingEnabled: boolean;
  dreamingFrequency: string;
  onDreamingEnabledChange: (value: boolean) => void;
  onDreamingFrequencyChange: (value: string) => void;
}

const FREQUENCY_PRESETS = [
  { value: '0 3 * * *', labelKey: 'coworkMemoryDreamingFreqNightly3am' },
  { value: '0 0 * * *', labelKey: 'coworkMemoryDreamingFreqMidnight' },
  { value: '0 0,12 * * *', labelKey: 'coworkMemoryDreamingFreqTwiceDaily' },
  { value: '0 */6 * * *', labelKey: 'coworkMemoryDreamingFreqEvery6h' },
  { value: '0 3 * * 0', labelKey: 'coworkMemoryDreamingFreqWeekly' },
] as const;

const CUSTOM_VALUE = '__custom__';
const DREAMING_INSIGHT_ROTATION_MS = 10_000;

const DREAMING_SCENE_STARS = [
  { top: '18%', left: '14%', size: 3, opacity: 0.55, tone: 'soft', delay: '0s' },
  { top: '55%', left: '7%', size: 2, opacity: 0.42, tone: 'soft', delay: '1.1s' },
  { top: '24%', left: '72%', size: 2, opacity: 0.32, tone: 'soft', delay: '0.7s' },
  { top: '66%', left: '94%', size: 2, opacity: 0.28, tone: 'soft', delay: '1.7s' },
  { top: '88%', left: '80%', size: 2, opacity: 0.45, tone: 'soft', delay: '0.3s' },
  { top: '84%', left: '25%', size: 2, opacity: 0.34, tone: 'accent', delay: '1.5s' },
  { top: '42%', left: '31%', size: 3, opacity: 0.55, tone: 'accent', delay: '0.9s' },
  { top: '39%', left: '89%', size: 2, opacity: 0.26, tone: 'soft', delay: '2s' },
] as const;

// ── Diary parser (mirrors OpenClaw's parseDiaryEntries) ──────────────

type DiaryEntry = {
  date: string;
  body: string;
};

const DIARY_START_RE = /<!--\s*openclaw:dreaming:diary:start\s*-->/;
const DIARY_END_RE = /<!--\s*openclaw:dreaming:diary:end\s*-->/;

function parseDiaryEntries(raw: string): DiaryEntry[] {
  let content = raw;
  const startMatch = DIARY_START_RE.exec(raw);
  const endMatch = DIARY_END_RE.exec(raw);
  if (startMatch && endMatch && endMatch.index > startMatch.index) {
    content = raw.slice(startMatch.index + startMatch[0].length, endMatch.index);
  }
  const entries: DiaryEntry[] = [];
  const blocks = content.split(/\n---\n/).filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    let date = '';
    const bodyLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!date && trimmed.startsWith('*') && trimmed.endsWith('*') && trimmed.length > 2) {
        date = trimmed.slice(1, -1);
        continue;
      }
      if (trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
      if (trimmed.length > 0) bodyLines.push(trimmed);
    }
    if (bodyLines.length > 0) {
      entries.push({ date, body: bodyLines.join('\n') });
    }
  }
  return entries;
}

function flattenDiaryBody(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        line !== 'What Happened' &&
        line !== 'Reflections' &&
        line !== 'Candidates' &&
        line !== 'Possible Lasting Updates',
    )
    .map((line) => line.replace(/\s*\[memory\/[^\]]+\]/g, ''))
    .map((line) =>
      line
        .replace(/^(?:\d+\.\s+|-\s+(?:\[[^\]]+\]\s+)?(?:[a-z_]+:\s+)?)/i, '')
        .replace(/^(?:likely_durable|likely_situational|unclear):\s+/i, '')
        .trim(),
    )
    .filter((line) => line.length > 0);
}

function formatDiaryChipLabel(date: string): string {
  const parsed = Date.parse(date);
  if (!Number.isFinite(parsed)) return date;
  const value = new Date(parsed);
  return `${value.getMonth() + 1}/${value.getDate()}`;
}

function formatPhaseNextRun(nextRunAtMs?: number): string {
  if (!nextRunAtMs) return '—';
  const d = new Date(nextRunAtMs);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatCronPreviewTime(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return '—';
  const minuteRaw = parts[0].split(',')[0];
  const hourRaw = parts[1].split(',')[0];
  if (/^\d+$/.test(minuteRaw) && /^\d+$/.test(hourRaw)) {
    return `${Number(hourRaw)}:${minuteRaw.padStart(2, '0')}`;
  }
  if (/^\*\/\d+$/.test(hourRaw)) {
    return `${hourRaw.slice(2)}h`;
  }
  return '—';
}

function formatPhaseRunLabel(phase: DreamingPhaseInfo | undefined, fallbackCron: string): string {
  if (phase?.enabled === false) return i18nService.t('coworkDreamingPhaseOff');
  if (phase?.nextRunAtMs) return formatPhaseNextRun(phase.nextRunAtMs);
  return formatCronPreviewTime(phase?.cron || fallbackCron);
}

function getDreamingInsightMessages(): string[] {
  const messages = i18nService
    .t('coworkDreamingInsightMessages')
    .split(/[,，]/)
    .map((message) => message.trim())
    .filter(Boolean);

  return messages.length > 0 ? messages : [i18nService.t('coworkDreamingInsightBrewing')];
}

function formatCompactDateTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatRange(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}:${startLine}` : `${path}:${startLine}-${endLine}`;
}

function describeEntryOrigin(entry: DreamingEntry): string {
  const hasGrounded = entry.groundedCount > 0;
  const hasLive = entry.recallCount > 0 || entry.dailyCount > 0;
  if (hasGrounded && hasLive) return i18nService.t('coworkDreamingAdvancedOriginMixed');
  if (hasGrounded) return i18nService.t('coworkDreamingAdvancedOriginDailyLog');
  return i18nService.t('coworkDreamingAdvancedOriginLive');
}

// ── Sub-components ───────────────────────────────────────────────────

type DreamingContentTab = 'scene' | 'diary' | 'advanced';
type AdvancedSort = 'recent' | 'signals';

function DreamingStarsLayer() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      {DREAMING_SCENE_STARS.map((star) => (
        <span
          key={`${star.top}-${star.left}`}
          className={`dreaming-scene-star dreaming-scene-star-${star.tone} absolute rounded-full`}
          style={{
            top: star.top,
            left: star.left,
            width: `${star.size}px`,
            height: `${star.size}px`,
            opacity: star.opacity,
            animationDelay: star.delay,
          }}
        />
      ))}
    </div>
  );
}

function DreamingMascot() {
  return (
    <div className="dreaming-mascot" aria-label={i18nService.t('coworkDreamingHeaderTitle')}>
      <div className="dreaming-mascot-glow" aria-hidden="true" />
      <img className="dreaming-mascot-image" src={dreamingLobsterSrc} alt="" draggable={false} />
      <span className="dreaming-z dreaming-z-one" aria-hidden="true">z</span>
      <span className="dreaming-z dreaming-z-two" aria-hidden="true">Z</span>
      <span className="dreaming-z dreaming-z-three" aria-hidden="true">Z</span>
    </div>
  );
}

function SceneTab({ status, fallbackCron }: { status: DreamingStatusData; fallbackCron: string }) {
  const currentLanguage = i18nService.getLanguage();
  const insightMessages = getDreamingInsightMessages();
  const [insightMessageIndex, setInsightMessageIndex] = useState(0);
  const phases = status.phases;
  const phaseEntries: { key: 'light' | 'deep' | 'rem'; labelKey: string }[] = [
    { key: 'light', labelKey: 'coworkDreamingPhaseLight' },
    { key: 'deep', labelKey: 'coworkDreamingPhaseDeep' },
    { key: 'rem', labelKey: 'coworkDreamingPhaseRem' },
  ];
  const nextRun = formatPhaseRunLabel(phases?.light || phases?.deep || phases?.rem, fallbackCron);
  const showNextRun = status.enabled && nextRun !== '—';
  const insightMessage = insightMessages[insightMessageIndex % insightMessages.length];

  useEffect(() => {
    setInsightMessageIndex(0);
  }, [currentLanguage]);

  useEffect(() => {
    if (!status.enabled || insightMessages.length <= 1) return undefined;

    const intervalId = window.setInterval(() => {
      setInsightMessageIndex((value) => value + 1);
    }, DREAMING_INSIGHT_ROTATION_MS);

    return () => window.clearInterval(intervalId);
  }, [status.enabled, insightMessages.length]);

  return (
    <div className="dreaming-scene relative h-[320px] overflow-hidden rounded-xl border border-border">
      <DreamingStarsLayer />
      <div className="dreaming-scene-orb absolute right-[9%] top-[10%] h-12 w-12 rounded-full" aria-hidden="true" />
      <div className="dreaming-scene-orb-haze absolute right-[13%] top-[14%] h-3 w-3 rounded-full blur-sm" aria-hidden="true" />

      {status.enabled && (
        <div className="dreaming-insight-bubble absolute left-[8%] top-[8%] z-10 max-w-[min(23rem,42%)] rounded-xl border px-4 py-2.5 text-sm font-medium italic leading-5 backdrop-blur-sm [overflow-wrap:anywhere]">
          {insightMessage}
        </div>
      )}

      <div className="absolute left-1/2 top-[41%] z-10 -translate-x-1/2 -translate-y-1/2">
        <DreamingMascot />
      </div>

      <div className="absolute bottom-[62px] left-0 right-0 z-10 flex flex-col items-center text-center">
        <div className="dreaming-scene-title text-xs font-semibold uppercase tracking-[0.18em]">
          DREAMING {status.enabled ? i18nService.t('coworkDreamingStatusActive') : i18nService.t('coworkDreamingStatusIdle')}
        </div>
        <div className={`mt-2 flex items-center gap-2 text-xs ${status.enabled ? 'dreaming-status-active' : 'dreaming-status-idle'}`}>
          <span className={`h-2 w-2 rounded-full ${status.enabled ? 'dreaming-status-dot-active' : 'dreaming-status-dot-idle'}`} />
          <span>
            {status.promotedToday} {i18nService.t('coworkDreamingPromoted')}
            {showNextRun ? ` · ${i18nService.t('coworkDreamingNextSweep')} ${nextRun}` : ''}
          </span>
        </div>
      </div>

      {status.enabled && (
        <div className="absolute bottom-4 left-0 right-0 z-10 flex flex-wrap justify-center gap-3 px-4">
          {phaseEntries.map(({ key, labelKey }) => {
            const phase = phases?.[key];
            const enabled = phase?.enabled !== false;
            return (
              <div
                key={key}
                className="dreaming-phase-card inline-flex min-w-[96px] items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs"
              >
                <span className={`h-2 w-2 rounded-full ${enabled ? 'dreaming-status-dot-active' : 'dreaming-status-dot-idle'}`} />
                <span className="dreaming-phase-label font-semibold">{i18nService.t(labelKey)}</span>
                <span className="dreaming-phase-time">{formatPhaseRunLabel(phase, fallbackCron)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DiaryTab({ diary, loading, onRefresh }: {
  diary: DreamDiaryData | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [page, setPage] = useState(0);

  const entries = useMemo(() => {
    if (!diary?.content) return [];
    return parseDiaryEntries(diary.content);
  }, [diary?.content]);

  const reversed = useMemo(() => [...entries].reverse(), [entries]);

  useEffect(() => { setPage(0); }, [diary?.content]);

  if (loading && !diary) {
    return <div className="px-3 py-10 text-center text-sm text-secondary">{i18nService.t('loading')}</div>;
  }

  if (!diary?.content || entries.length === 0) {
    return (
      <div className="flex min-h-[260px] flex-col items-center justify-center space-y-2 rounded-xl border border-border bg-surface text-center">
        <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>{i18nService.t('coworkDreamingDiaryEmpty')}</div>
        <div className={`${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{i18nService.t('coworkDreamingDiaryEmptyHint')}</div>
      </div>
    );
  }

  const currentPage = Math.max(0, Math.min(page, reversed.length - 1));
  const entry = reversed[currentPage];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={`max-w-xl ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{i18nService.t('coworkDreamingDiaryHint')}</p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
        >
          {loading ? i18nService.t('coworkDreamingDiaryRefreshing') : i18nService.t('coworkDreamingDiaryRefresh')}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {reversed.map((e, idx) => (
          <button
            type="button"
            key={idx}
            onClick={() => setPage(idx)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              idx === currentPage
                ? 'bg-primary-muted text-primary'
                : 'border border-border bg-surface text-secondary hover:bg-surface-raised hover:text-foreground'
            }`}
          >
            {formatDiaryChipLabel(e.date)}
          </button>
        ))}
      </div>

      {entry && (
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          {entry.date && (
            <div className="mb-3 text-xs font-medium text-secondary">{entry.date}</div>
          )}
          <div className="space-y-2">
            {flattenDiaryBody(entry.body).map((para, i) => (
              <p key={i} className="text-sm leading-6 text-foreground">{para}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AdvancedEntryList({ title, description, emptyText, entries, badge }: {
  title: string;
  description: string;
  emptyText: string;
  entries: DreamingEntry[];
  badge?: (entry: DreamingEntry) => string;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>{title}</div>
          <div className={`mt-1 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{description}</div>
        </div>
        <span className="rounded-full border border-border bg-surface-raised px-2 py-1 text-xs text-secondary">{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <div className={`rounded-xl border border-border bg-surface px-4 py-4 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{emptyText}</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          {entries.map((entry, index) => (
            <div key={entry.key} className={`space-y-2 px-4 py-3 text-xs ${index > 0 ? 'border-t border-border' : ''}`}>
              {badge && (
                <span className={`inline-block rounded-full bg-surface-raised px-2 py-0.5 ${SETTINGS_META_TEXT} text-secondary`}>
                  {badge(entry)}
                </span>
              )}
              <div className={`${SETTINGS_ITEM_TITLE_TEXT} text-foreground`}>{entry.snippet}</div>
              <div className={`font-mono ${SETTINGS_META_TEXT} text-secondary`}>
                {formatRange(entry.path, entry.startLine, entry.endLine)}
              </div>
              <div className={`${SETTINGS_META_TEXT} text-secondary`}>
                {[
                  entry.totalSignalCount > 0 ? `${entry.totalSignalCount} signals` : '',
                  entry.recallCount > 0 ? `${entry.recallCount} recall` : '',
                  entry.dailyCount > 0 ? `${entry.dailyCount} daily` : '',
                  entry.groundedCount > 0 ? `${entry.groundedCount} grounded` : '',
                  entry.promotedAt ? `promoted ${formatCompactDateTime(entry.promotedAt)}` : '',
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AdvancedMemorySignals({ status }: { status: DreamingStatusData }) {
  const [sort, setSort] = useState<AdvancedSort>('recent');

  const groundedEntries = useMemo(
    () => status.shortTermEntries.filter((e) => e.groundedCount > 0),
    [status.shortTermEntries],
  );

  const waitingEntries = useMemo(() => {
    const sorted = [...status.shortTermEntries];
    if (sort === 'signals') {
      sorted.sort((a, b) => {
        if (b.totalSignalCount !== a.totalSignalCount) return b.totalSignalCount - a.totalSignalCount;
        if (b.phaseHitCount !== a.phaseHitCount) return b.phaseHitCount - a.phaseHitCount;
        return 0;
      });
    } else {
      sorted.sort((a, b) => {
        const aMs = a.lastRecalledAt ? Date.parse(a.lastRecalledAt) : -Infinity;
        const bMs = b.lastRecalledAt ? Date.parse(b.lastRecalledAt) : -Infinity;
        if (bMs !== aMs) return bMs - aMs;
        return b.totalSignalCount - a.totalSignalCount;
      });
    }
    return sorted;
  }, [status.shortTermEntries, sort]);

  const summary = [
    `${groundedEntries.length} ${i18nService.t('coworkDreamingAdvancedSummaryFromDailyLog')}`,
    `${status.shortTermCount} ${i18nService.t('coworkDreamingAdvancedSummaryWaiting')}`,
    `${status.promotedToday} ${i18nService.t('coworkDreamingAdvancedSummaryPromotedToday')}`,
  ].join(' · ');

  return (
    <div className="space-y-5">
      <div>
        <p className={`${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{i18nService.t('coworkDreamingAdvancedHint')}</p>
        <div className={`mt-1 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{summary}</div>
      </div>

      <AdvancedEntryList
        title={i18nService.t('coworkDreamingAdvancedGroundedTitle')}
        description={i18nService.t('coworkDreamingAdvancedGroundedDesc')}
        emptyText={i18nService.t('coworkDreamingAdvancedGroundedEmpty')}
        entries={groundedEntries}
        badge={() => i18nService.t('coworkDreamingAdvancedOriginDailyLog')}
      />

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>{i18nService.t('coworkDreamingAdvancedWaitingTitle')}</div>
            <div className={`mt-1 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{i18nService.t('coworkDreamingAdvancedWaitingDesc')}</div>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1">
            <button
              type="button"
              onClick={() => setSort('recent')}
              className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                sort === 'recent' ? 'bg-primary-muted text-primary' : 'text-secondary hover:text-foreground'
              }`}
            >
              {i18nService.t('coworkDreamingAdvancedSortRecent')}
            </button>
            <button
              type="button"
              onClick={() => setSort('signals')}
              className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                sort === 'signals' ? 'bg-primary-muted text-primary' : 'text-secondary hover:text-foreground'
              }`}
            >
              {i18nService.t('coworkDreamingAdvancedSortSignals')}
            </button>
          </div>
        </div>
        {waitingEntries.length === 0 ? (
          <div className={`rounded-xl border border-border bg-surface px-4 py-4 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{i18nService.t('coworkDreamingAdvancedWaitingEmpty')}</div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            {waitingEntries.map((entry, index) => (
              <div key={entry.key} className={`space-y-2 px-4 py-3 text-xs ${index > 0 ? 'border-t border-border' : ''}`}>
                <span className={`inline-block rounded-full bg-surface-raised px-2 py-0.5 ${SETTINGS_META_TEXT} text-secondary`}>
                  {describeEntryOrigin(entry)}
                </span>
                <div className={`${SETTINGS_ITEM_TITLE_TEXT} text-foreground`}>{entry.snippet}</div>
                <div className={`font-mono ${SETTINGS_META_TEXT} text-secondary`}>
                  {formatRange(entry.path, entry.startLine, entry.endLine)}
                </div>
                <div className={`${SETTINGS_META_TEXT} text-secondary`}>
                  {[
                    entry.totalSignalCount > 0 ? `${entry.totalSignalCount} signals` : '',
                    entry.recallCount > 0 ? `${entry.recallCount} recall` : '',
                    entry.dailyCount > 0 ? `${entry.dailyCount} daily` : '',
                    entry.groundedCount > 0 ? `${entry.groundedCount} grounded` : '',
                    entry.phaseHitCount > 0 ? `${entry.phaseHitCount} phase hit` : '',
                  ].filter(Boolean).join(' · ')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <AdvancedEntryList
        title={i18nService.t('coworkDreamingAdvancedPromotedTitle')}
        description={i18nService.t('coworkDreamingAdvancedPromotedDesc')}
        emptyText={i18nService.t('coworkDreamingAdvancedPromotedEmpty')}
        entries={status.promotedEntries}
        badge={(entry) => describeEntryOrigin(entry)}
      />
    </div>
  );
}

function AdvancedSettingsPanel({
  dreamingFrequency,
  customMode,
  onSelectFrequency,
  onDreamingFrequencyChange,
}: {
  dreamingFrequency: string;
  customMode: boolean;
  onSelectFrequency: (value: string) => void;
  onDreamingFrequencyChange: (value: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-4">
      <div className="mb-4">
        <h3 className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>{i18nService.t('coworkDreamingSettingsTitle')}</h3>
        <p className={`mt-1 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{i18nService.t('coworkMemoryDreamingEnabledHint')}</p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-foreground">
            {i18nService.t('coworkMemoryDreamingFrequency')}
          </label>
          <select
            value={customMode ? CUSTOM_VALUE : dreamingFrequency}
            onChange={(e) => onSelectFrequency(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary"
          >
            {FREQUENCY_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {i18nService.t(preset.labelKey)}
              </option>
            ))}
            <option value={CUSTOM_VALUE}>
              {i18nService.t('coworkMemoryDreamingFreqCustom')}
            </option>
          </select>
          <div className="mt-1.5 text-xs text-secondary">
            {i18nService.t('coworkMemoryDreamingFrequencyHint')}
          </div>
        </div>

        {customMode && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">
              {i18nService.t('coworkMemoryDreamingFreqCustom')}
            </label>
            <input
              type="text"
              value={dreamingFrequency}
              onChange={(e) => onDreamingFrequencyChange(e.target.value)}
              placeholder={i18nService.t('coworkMemoryDreamingFreqCustomPlaceholder')}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none transition-colors placeholder:text-secondary/50 focus:border-primary"
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────

const DreamingSettingsSection: React.FC<DreamingSettingsSectionProps> = ({
  dreamingEnabled,
  dreamingFrequency,
  onDreamingEnabledChange,
  onDreamingFrequencyChange,
}) => {
  const [contentTab, setContentTab] = useState<DreamingContentTab>('scene');

  const [dreamingStatus, setDreamingStatus] = useState<DreamingStatusData | null>(null);
  const [dreamDiary, setDreamDiary] = useState<DreamDiaryData | null>(null);
  const [_statusLoading, setStatusLoading] = useState(false);
  const [diaryLoading, setDiaryLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const isPreset = useMemo(
    () => FREQUENCY_PRESETS.some((p) => p.value === dreamingFrequency),
    [dreamingFrequency],
  );
  const [customMode, setCustomMode] = useState(!isPreset);

  useEffect(() => {
    setCustomMode(!isPreset);
  }, [isPreset]);

  const localTimezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    [],
  );

  const fallbackDreamingStatus = useMemo<DreamingStatusData>(() => ({
    enabled: dreamingEnabled,
    timezone: localTimezone,
    shortTermCount: 0,
    groundedSignalCount: 0,
    totalSignalCount: 0,
    promotedToday: 0,
    promotedTotal: 0,
    shortTermEntries: [],
    promotedEntries: [],
    phases: {
      light: { enabled: dreamingEnabled, cron: dreamingFrequency },
      deep: { enabled: dreamingEnabled, cron: dreamingFrequency },
      rem: { enabled: dreamingEnabled, cron: dreamingFrequency },
    },
  }), [dreamingEnabled, dreamingFrequency, localTimezone]);

  const visualStatus = useMemo<DreamingStatusData>(() => {
    const base = dreamingStatus ?? fallbackDreamingStatus;
    const phases = base.phases ?? fallbackDreamingStatus.phases;
    if (dreamingEnabled) {
      return {
        ...fallbackDreamingStatus,
        ...base,
        enabled: true,
        phases,
        shortTermEntries: base.shortTermEntries ?? [],
        promotedEntries: base.promotedEntries ?? [],
      };
    }
    return {
      ...fallbackDreamingStatus,
      ...base,
      enabled: false,
      phases: phases
        ? {
            light: { ...phases.light, enabled: false },
            deep: { ...phases.deep, enabled: false },
            rem: { ...phases.rem, enabled: false },
          }
        : undefined,
      shortTermEntries: base.shortTermEntries ?? [],
      promotedEntries: base.promotedEntries ?? [],
    };
  }, [dreamingEnabled, dreamingStatus, fallbackDreamingStatus]);

  const handleSelectChange = (val: string) => {
    if (val === CUSTOM_VALUE) {
      setCustomMode(true);
    } else {
      setCustomMode(false);
      onDreamingFrequencyChange(val);
    }
  };

  const fetchDreamingStatus = useCallback(async () => {
    setStatusLoading(true);
    setLoadError(null);
    try {
      const result = await (window as any).electron.cowork.getDreamingStatus();
      if (result?.success && result.data) {
        setDreamingStatus(result.data);
      } else if (result?.error) {
        setLoadError(result.error);
      }
    } catch {
      setLoadError(i18nService.t('coworkDreamingLoadError'));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const fetchDreamDiary = useCallback(async () => {
    setDiaryLoading(true);
    try {
      const result = await (window as any).electron.cowork.getDreamDiary();
      if (result?.success && result.data) {
        setDreamDiary(result.data);
      }
    } catch {
      // Diary is secondary content; keep the scene available if it fails.
    } finally {
      setDiaryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (dreamingEnabled) {
      void fetchDreamingStatus();
      void fetchDreamDiary();
    }
  }, [dreamingEnabled, fetchDreamingStatus, fetchDreamDiary]);

  const contentTabs = [
    { key: 'scene' as const, labelKey: 'coworkDreamingSubTabScene' },
    { key: 'diary' as const, labelKey: 'coworkDreamingSubTabDiary' },
    { key: 'advanced' as const, labelKey: 'coworkDreamingSubTabAdvanced' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <p className={`${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{i18nService.t('coworkDreamingHeaderSubtitle')}</p>

        <button
          type="button"
          role="switch"
          aria-checked={dreamingEnabled}
          onClick={() => onDreamingEnabledChange(!dreamingEnabled)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
            dreamingEnabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              dreamingEnabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      <div className="rounded-xl border border-border bg-surface p-3">
        <div className="mb-3 flex flex-wrap gap-2 border-b border-border pb-3">
          {contentTabs.map((tab) => (
            <button
              type="button"
              key={tab.key}
              onClick={() => setContentTab(tab.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                contentTab === tab.key
                  ? 'bg-primary-muted text-primary'
                  : 'text-secondary hover:bg-surface-raised hover:text-foreground'
              }`}
            >
              {i18nService.t(tab.labelKey)}
            </button>
          ))}
        </div>

        {loadError && (
          <div className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {loadError}
          </div>
        )}

        {contentTab === 'scene' && (
          <SceneTab status={visualStatus} fallbackCron={dreamingFrequency} />
        )}

        {contentTab === 'diary' && (
          <DiaryTab diary={dreamDiary} loading={diaryLoading} onRefresh={fetchDreamDiary} />
        )}

        {contentTab === 'advanced' && (
          <div className="space-y-6">
            <AdvancedSettingsPanel
              dreamingFrequency={dreamingFrequency}
              customMode={customMode}
              onSelectFrequency={handleSelectChange}
              onDreamingFrequencyChange={onDreamingFrequencyChange}
            />
            <AdvancedMemorySignals status={visualStatus} />
          </div>
        )}
      </div>
    </div>
  );
};

export default DreamingSettingsSection;
