import { ArrowPathIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { HtmlShareAnalytics } from '../../../shared/htmlShare/constants';
import { i18nService } from '../../services/i18n';
import {
  MANAGEMENT_BODY_TEXT,
  MANAGEMENT_META_TEXT,
  MANAGEMENT_TITLE_TEXT,
} from '../common/managementTypography';
import SiteAnalyticsChart from '../sites/SiteAnalyticsChart';

const LibraryShareAnalyticsRange = {
  SevenDays: 7,
  ThirtyDays: 30,
} as const;

type LibraryShareAnalyticsRange =
  (typeof LibraryShareAnalyticsRange)[keyof typeof LibraryShareAnalyticsRange];

interface LibraryShareAnalyticsState {
  analytics?: HtmlShareAnalytics;
  loading: boolean;
  error?: string;
}

const toLocalDateValue = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const libraryShareAnalyticsDateValues = (
  range: LibraryShareAnalyticsRange,
  today = new Date(),
): { from: string; to: string } => {
  const to = new Date(today);
  const from = new Date(today);
  from.setDate(from.getDate() - (range - 1));
  return { from: toLocalDateValue(from), to: toLocalDateValue(to) };
};

const formatAnalyticsDate = (value: string): string => {
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(date);
};

const formatMetric = (value: number): string => new Intl.NumberFormat(
  i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US',
).format(value);

interface LibraryShareAnalyticsViewProps {
  shareId: string;
}

const LibraryShareAnalyticsView: React.FC<LibraryShareAnalyticsViewProps> = ({ shareId }) => {
  const [range, setRange] = useState<LibraryShareAnalyticsRange>(
    LibraryShareAnalyticsRange.SevenDays,
  );
  const [reloadSequence, setReloadSequence] = useState(0);
  const [state, setState] = useState<LibraryShareAnalyticsState>({ loading: true });
  const requestSequence = useRef(0);
  const requestedDates = useMemo(() => libraryShareAnalyticsDateValues(range), [range]);

  useEffect(() => {
    const requestId = ++requestSequence.current;
    setState({ loading: true });
    void window.electron.htmlShare.getAnalytics({
      shareId,
      ...requestedDates,
    }).then(result => {
      if (requestSequence.current !== requestId) return;
      if (!result.success || !result.analytics) {
        setState({
          loading: false,
          error: result.error ?? i18nService.t('libraryShareAnalyticsLoadFailed'),
        });
        return;
      }
      setState({ analytics: result.analytics, loading: false });
    }).catch(error => {
      if (requestSequence.current !== requestId) return;
      setState({
        loading: false,
        error: error instanceof Error
          ? error.message
          : i18nService.t('libraryShareAnalyticsLoadFailed'),
      });
    });
    return () => {
      if (requestSequence.current === requestId) requestSequence.current += 1;
    };
  }, [reloadSequence, requestedDates, shareId]);

  const analytics = state.analytics;
  const chartTrend = analytics?.trend.map(item => ({
    date: item.date,
    pageViews: item.accesses,
    uniqueVisitors: item.uniqueVisitors,
  })) ?? [];

  return (
    <div className="mt-5 space-y-3">
      <div className="flex min-h-9 items-center justify-between gap-4 px-0.5">
        <div>
          <h2 className={`${MANAGEMENT_TITLE_TEXT} font-semibold text-foreground`}>
            {i18nService.t('librarySharePerformance')}
          </h2>
          <p className={`${MANAGEMENT_META_TEXT} mt-1 leading-[var(--lobster-leading-xs)] text-secondary`}>
            {formatAnalyticsDate(analytics?.meta.from ?? requestedDates.from)}
            {' – '}
            {formatAnalyticsDate(analytics?.meta.to ?? requestedDates.to)}
          </p>
        </div>
        <select
          value={range}
          onChange={event => setRange(Number(event.target.value) as LibraryShareAnalyticsRange)}
          className="h-8 min-w-28 rounded-lg border border-border bg-surface px-3 text-xs text-foreground outline-none transition-colors hover:bg-surface-raised focus:border-primary"
          aria-label={i18nService.t('libraryShareAnalyticsDateRange')}
        >
          <option value={LibraryShareAnalyticsRange.SevenDays}>
            {i18nService.t('libraryShareAnalyticsPast7Days')}
          </option>
          <option value={LibraryShareAnalyticsRange.ThirtyDays}>
            {i18nService.t('libraryShareAnalyticsPast30Days')}
          </option>
        </select>
      </div>

      {state.loading ? (
        <div className={`flex h-56 items-center justify-center ${MANAGEMENT_BODY_TEXT} text-secondary`}>
          <ArrowPathIcon className="mr-2 h-4 w-4 animate-spin" />
          {i18nService.t('loading')}
        </div>
      ) : state.error ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-8 text-center">
          <p className={`${MANAGEMENT_BODY_TEXT} text-amber-700 dark:text-amber-300`}>
            {state.error}
          </p>
          <button
            type="button"
            onClick={() => setReloadSequence(value => value + 1)}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary"
          >
            <ArrowPathIcon className="h-3.5 w-3.5" />
            {i18nService.t('retry')}
          </button>
        </div>
      ) : analytics ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className={`${MANAGEMENT_META_TEXT} leading-[var(--lobster-leading-xs)] text-secondary`}>
                {i18nService.t('libraryShareAnalyticsUniqueVisitors')}
              </p>
              <p className="mt-1.5 text-2xl font-semibold leading-none text-foreground">
                {formatMetric(analytics.summary.uniqueVisitors)}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className={`${MANAGEMENT_META_TEXT} leading-[var(--lobster-leading-xs)] text-secondary`}>
                {i18nService.t('libraryShareAnalyticsAccesses')}
              </p>
              <p className="mt-1.5 text-2xl font-semibold leading-none text-foreground">
                {formatMetric(analytics.summary.accesses)}
              </p>
            </div>
          </div>
          <SiteAnalyticsChart
            trend={chartTrend}
            title={i18nService.t('libraryShareAnalyticsTrend')}
            subtitle={i18nService.t('libraryShareAnalyticsDaily')}
            uniqueVisitorsLabel={i18nService.t('libraryShareAnalyticsUniqueVisitors')}
            volumeLabel={i18nService.t('libraryShareAnalyticsAccesses')}
            ariaLabel={i18nService.t('libraryShareAnalyticsTrend')}
          />
          <p className={`${MANAGEMENT_META_TEXT} px-1 leading-[var(--lobster-leading-xs)] text-tertiary`}>
            {i18nService.t('libraryShareAnalyticsVisitorHint')}
          </p>
        </>
      ) : null}
    </div>
  );
};

export default LibraryShareAnalyticsView;
