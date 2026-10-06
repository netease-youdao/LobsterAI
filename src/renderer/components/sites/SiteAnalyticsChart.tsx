import React, { useMemo } from 'react';

import type { SiteAnalytics } from '../../../shared/site/constants';
import { i18nService } from '../../services/i18n';
import {
  MANAGEMENT_META_TEXT,
  MANAGEMENT_TITLE_TEXT,
} from '../common/managementTypography';

interface SiteAnalyticsChartProps {
  trend: SiteAnalytics['trend'];
  title?: string;
  subtitle?: string;
  uniqueVisitorsLabel?: string;
  volumeLabel?: string;
  ariaLabel?: string;
}

const WIDTH = 820;
const HEIGHT = 250;
const LEFT = 42;
const RIGHT = 16;
const TOP = 18;
const BOTTOM = 34;

const SERIES_COLORS = {
  uniqueVisitors: '#168AFB',
  pageViews: '#9B51E0',
} as const;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const smoothPath = (points: Array<[number, number]>): string => {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`;
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const beforePrevious = points[index - 1] ?? previous;
    const next = points[index + 2] ?? point;
    const control1X = previous[0] + (point[0] - beforePrevious[0]) / 6;
    const minY = Math.min(previous[1], point[1]);
    const maxY = Math.max(previous[1], point[1]);
    const control1Y = clamp(previous[1] + (point[1] - beforePrevious[1]) / 6, minY, maxY);
    const control2X = point[0] - (next[0] - previous[0]) / 6;
    const control2Y = clamp(point[1] - (next[1] - previous[1]) / 6, minY, maxY);
    return `${path} C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${point[0]} ${point[1]}`;
  }, `M ${points[0][0]} ${points[0][1]}`);
};

const SiteAnalyticsChart: React.FC<SiteAnalyticsChartProps> = ({
  trend,
  title = i18nService.t('sitesTraffic'),
  subtitle = i18nService.t('sitesDailyGranularity'),
  uniqueVisitorsLabel = i18nService.t('sitesUniqueVisitors'),
  volumeLabel = i18nService.t('sitesPageViews'),
  ariaLabel = i18nService.t('sitesTrafficTrend'),
}) => {
  const chart = useMemo(() => {
    const rawMax = Math.max(1, ...trend.flatMap(item => [item.pageViews, item.uniqueVisitors]));
    const step = rawMax <= 12 ? 3 : Math.ceil(rawMax / 4);
    const max = Math.max(step * 4, rawMax);
    const plotWidth = WIDTH - LEFT - RIGHT;
    const plotHeight = HEIGHT - TOP - BOTTOM;
    const pointFor = (value: number, index: number): [number, number] => [
      LEFT + (trend.length <= 1 ? 0 : (index / (trend.length - 1)) * plotWidth),
      TOP + plotHeight - (value / max) * plotHeight,
    ];
    return {
      max,
      pageViews: trend.map((item, index) => pointFor(item.pageViews, index)),
      visitors: trend.map((item, index) => pointFor(item.uniqueVisitors, index)),
      labelIndexes: trend
        .map((_, index) => index)
        .filter(
          index =>
            index === 0 ||
            index === trend.length - 1 ||
            index % Math.max(1, Math.ceil(trend.length / 6)) === 0,
        ),
    };
  }, [trend]);

  const formatDate = (value: string): string => {
    const date = new Date(`${value}T00:00:00`);
    return new Intl.DateTimeFormat(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric',
    }).format(date);
  };

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div>
          <h3 className={`${MANAGEMENT_TITLE_TEXT} font-semibold text-foreground`}>{title}</h3>
          <p className={`${MANAGEMENT_META_TEXT} mt-0.5 leading-[var(--lobster-leading-xs)] text-secondary`}>
            {subtitle}
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs text-secondary">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: SERIES_COLORS.uniqueVisitors }}
            />
            {uniqueVisitorsLabel}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: SERIES_COLORS.pageViews }}
            />
            {volumeLabel}
          </span>
        </div>
      </div>
      <div className="w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="block h-auto w-full"
          role="img"
          aria-label={ariaLabel}
        >
          <defs>
            <linearGradient id="sitePvFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={SERIES_COLORS.pageViews} stopOpacity="0.14" />
              <stop offset="1" stopColor={SERIES_COLORS.pageViews} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3, 4].map(index => {
            const y = TOP + ((HEIGHT - TOP - BOTTOM) / 4) * index;
            const value = Math.round(chart.max - (chart.max / 4) * index);
            return (
              <g key={index}>
                <line
                  x1={LEFT}
                  x2={WIDTH - RIGHT}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  className="text-border"
                  strokeDasharray="3 4"
                />
                <text
                  x={LEFT - 10}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-secondary text-[10px]"
                >
                  {value}
                </text>
              </g>
            );
          })}
          {chart.pageViews.length > 1 && (
            <path
              d={`${smoothPath(chart.pageViews)} L ${chart.pageViews[chart.pageViews.length - 1][0]} ${HEIGHT - BOTTOM} L ${chart.pageViews[0][0]} ${HEIGHT - BOTTOM} Z`}
              fill="url(#sitePvFill)"
            />
          )}
          <path
            d={smoothPath(chart.visitors)}
            fill="none"
            stroke={SERIES_COLORS.uniqueVisitors}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={smoothPath(chart.pageViews)}
            fill="none"
            stroke={SERIES_COLORS.pageViews}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {chart.labelIndexes.map(index => (
            <text
              key={index}
              x={chart.pageViews[index]?.[0] ?? LEFT}
              y={HEIGHT - 10}
              textAnchor={index === 0 ? 'start' : index === trend.length - 1 ? 'end' : 'middle'}
              className="fill-secondary text-[10px]"
            >
              {trend[index] ? formatDate(trend[index].date) : ''}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
};

export default SiteAnalyticsChart;
