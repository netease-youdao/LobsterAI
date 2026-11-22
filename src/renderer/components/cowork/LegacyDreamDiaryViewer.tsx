import { InformationCircleIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useState } from 'react';

import { AgentId } from '../../../shared/agent/constants';
import { i18nService } from '../../services/i18n';
import type { LegacyAgentDreamDiary } from '../../types/cowork';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_ITEM_TITLE_TEXT,
  SETTINGS_META_TEXT,
} from '../settings/settingsTypography';
import {
  flattenDiaryBody,
  formatDiaryChipLabel,
  parseDiaryEntries,
} from './dreamDiaryParser';

const DiaryViewMode = {
  Parsed: 'parsed',
  Raw: 'raw',
} as const;
type DiaryViewMode = typeof DiaryViewMode[keyof typeof DiaryViewMode];

interface LegacyDreamDiaryViewerProps {
  diaries: LegacyAgentDreamDiary[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

const formatAgentLabel = (diary: LegacyAgentDreamDiary): string => {
  if (diary.agentId === AgentId.Main) {
    return i18nService.t('coworkDreamingLegacyMainAgent');
  }
  return diary.agentName?.trim() || diary.agentId;
};

const LegacyDreamDiaryViewer: React.FC<LegacyDreamDiaryViewerProps> = ({
  diaries,
  loading,
  error,
  onRefresh,
}) => {
  const [selectedAgentId, setSelectedAgentId] = useState<string>(diaries[0]?.agentId ?? '');
  const [viewMode, setViewMode] = useState<DiaryViewMode>(DiaryViewMode.Parsed);
  const [page, setPage] = useState<number>(0);

  useEffect(() => {
    if (diaries.length === 0) {
      setSelectedAgentId('');
      return;
    }
    if (!diaries.some((item) => item.agentId === selectedAgentId)) {
      setSelectedAgentId(diaries[0].agentId);
    }
  }, [diaries, selectedAgentId]);

  const activeDiary = useMemo(
    () => diaries.find((item) => item.agentId === selectedAgentId) ?? diaries[0] ?? null,
    [diaries, selectedAgentId],
  );

  const entries = useMemo(() => {
    if (!activeDiary?.content) return [];
    return parseDiaryEntries(activeDiary.content);
  }, [activeDiary?.content]);

  const reversedEntries = useMemo(() => [...entries].reverse(), [entries]);

  useEffect(() => {
    setPage(0);
  }, [activeDiary?.agentId, activeDiary?.content]);

  if (!activeDiary) {
    return null;
  }

  const effectiveViewMode: DiaryViewMode =
    entries.length === 0 ? DiaryViewMode.Raw : viewMode;
  const currentPage = Math.max(0, Math.min(page, reversedEntries.length - 1));
  const currentEntry = reversedEntries[currentPage];
  const paragraphs = currentEntry
    ? (() => {
        const flattened = flattenDiaryBody(currentEntry.body);
        if (flattened.length > 0) return flattened;
        return currentEntry.body
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
      })()
    : [];

  return (
    <div className="space-y-4 rounded-xl border border-border px-4 py-4">
      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-raised/50 px-3 py-2.5">
        <InformationCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-secondary" />
        <p className={`${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
          {i18nService.t('coworkDreamingLegacyReadOnlyNotice')}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
            {i18nService.t('coworkMemoryTabLegacyDreamDiary')}
          </div>
          <span
            className={`rounded-full border border-border bg-surface-raised px-2 py-0.5 ${SETTINGS_META_TEXT} text-secondary`}
          >
            {i18nService.t('coworkDreamingLegacyReadOnlyBadge')}
          </span>
          {diaries.length === 1 && activeDiary.agentId !== AgentId.Main && (
            <span
              className={`rounded-full border border-border bg-surface px-2 py-0.5 ${SETTINGS_META_TEXT} text-secondary`}
            >
              {formatAgentLabel(activeDiary)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {entries.length > 0 && (
            <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5">
              <button
                type="button"
                onClick={() => setViewMode(DiaryViewMode.Parsed)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  effectiveViewMode === DiaryViewMode.Parsed
                    ? 'bg-primary-muted text-primary'
                    : 'text-secondary hover:text-foreground'
                }`}
              >
                {i18nService.t('coworkDreamingLegacyViewParsed')}
              </button>
              <button
                type="button"
                onClick={() => setViewMode(DiaryViewMode.Raw)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  effectiveViewMode === DiaryViewMode.Raw
                    ? 'bg-primary-muted text-primary'
                    : 'text-secondary hover:text-foreground'
                }`}
              >
                {i18nService.t('coworkDreamingLegacyViewRaw')}
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
          >
            {loading
              ? i18nService.t('coworkDreamingDiaryRefreshing')
              : i18nService.t('coworkDreamingDiaryRefresh')}
          </button>
        </div>
      </div>

      {diaries.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {diaries.map((item) => (
            <button
              type="button"
              key={item.agentId}
              onClick={() => setSelectedAgentId(item.agentId)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                item.agentId === activeDiary.agentId
                  ? 'bg-primary-muted text-primary'
                  : 'border border-border bg-surface text-secondary hover:bg-surface-raised hover:text-foreground'
              }`}
            >
              {formatAgentLabel(item)}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300 [overflow-wrap:anywhere]">
          {i18nService.t('coworkDreamingDiaryLoadError')}: {error}
        </div>
      )}

      {effectiveViewMode === DiaryViewMode.Raw ? (
        <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-raised/40 px-4 py-3 text-xs font-mono leading-relaxed text-foreground select-text">
          {activeDiary.content}
        </pre>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {reversedEntries.map((entry, idx) => (
              <button
                type="button"
                key={`${entry.date}-${idx}`}
                onClick={() => setPage(idx)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  idx === currentPage
                    ? 'bg-primary-muted text-primary'
                    : 'border border-border bg-surface text-secondary hover:bg-surface-raised hover:text-foreground'
                }`}
              >
                {entry.date
                  ? formatDiaryChipLabel(entry.date)
                  : i18nService
                      .t('coworkDreamingLegacyUntitledEntry')
                      .replace('{index}', String(idx + 1))}
              </button>
            ))}
          </div>

          {currentEntry && (
            <div className="rounded-xl border border-border bg-surface px-4 py-3 select-text">
              {currentEntry.date && (
                <div className="mb-3 text-xs font-medium text-secondary">
                  {currentEntry.date}
                </div>
              )}
              <div className="space-y-2">
                {paragraphs.map((para, idx) => (
                  <p key={idx} className="text-sm leading-6 text-foreground">
                    {para}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LegacyDreamDiaryViewer;
