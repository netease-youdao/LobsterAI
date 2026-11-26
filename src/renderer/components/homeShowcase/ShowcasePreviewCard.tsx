import {
  ComputerDesktopIcon,
  DevicePhoneMobileIcon,
  GlobeAltIcon,
  PhotoIcon,
  TableCellsIcon,
} from '@heroicons/react/24/outline';
import React, { useState } from 'react';

import {
  type HomeShowcaseExample,
  ShowcasePreviewKind,
} from '../../../shared/homeShowcase/constants';
import { i18nService } from '../../services/i18n';
import { getShowcaseCoverImage } from './coverImages';

export const ShowcaseCardThumbnail: React.FC<{ example: HomeShowcaseExample }> = ({ example }) => {
  const coverUrl = getShowcaseCoverImage(example.id);
  const [failed, setFailed] = useState(false);

  return (
    <div className="relative aspect-[16/10] w-full overflow-hidden rounded-2xl bg-surface-raised">
      {coverUrl && !failed ? (
        <img
          src={coverUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-raised to-surface text-secondary">
          <PhotoIcon aria-hidden="true" className="h-7 w-7 opacity-40" />
        </div>
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.08]"
      />
    </div>
  );
};

export const ShowcasePreviewStage: React.FC<{ example: HomeShowcaseExample }> = ({ example }) => {
  const language = i18nService.getLanguage();
  const t = (key: string) => i18nService.t(key);
  const coverUrl = getShowcaseCoverImage(example.id);
  const [slideIndex, setSlideIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'result' | 'raw'>('result');
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');

  const { preview } = example;

  if (preview.kind === ShowcasePreviewKind.ResearchReport) {
    return (
      <div className="flex h-full flex-col gap-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/12 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">
            <GlobeAltIcon aria-hidden="true" className="h-3.5 w-3.5" />
            {t('homeShowcaseSourcesMeta').replace('{count}', String(preview.sourceCount))}
          </span>
          <span className="text-xs text-foreground/60">{preview.kicker[language]}</span>
        </div>

        {coverUrl && (
          <div className="overflow-hidden rounded-2xl border border-border/80 bg-surface shadow-card">
            <img
              src={coverUrl}
              alt={example.title[language]}
              className="aspect-[16/10] w-full object-cover"
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-subtle scrollbar-hidden">
          <p className="text-xs leading-5 text-foreground/85">{preview.summary[language]}</p>

          <div className="mt-3 overflow-hidden rounded-xl border border-border">
            <div
              className="grid gap-2 border-b border-border bg-surface-raised/80 px-3 py-1.5 text-[11px] font-semibold text-secondary"
              style={{ gridTemplateColumns: `repeat(${preview.tableHeaders.length}, minmax(0, 1fr))` }}
            >
              {preview.tableHeaders.map((header, idx) => (
                <span key={idx} className="truncate">{header[language]}</span>
              ))}
            </div>
            {preview.tableRows.map((row, rowIdx) => (
              <div
                key={rowIdx}
                className={`grid gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-b-0 ${
                  row.highlight ? 'bg-indigo-500/[0.06] font-medium text-foreground' : 'text-foreground/80'
                }`}
                style={{ gridTemplateColumns: `repeat(${preview.tableHeaders.length}, minmax(0, 1fr))` }}
              >
                {row.cells.map((cell, cellIdx) => (
                  <span key={cellIdx} className="truncate">{cell[language]}</span>
                ))}
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {preview.citations.map((citation, idx) => (
              <span
                key={idx}
                className="rounded-md border border-border/80 bg-surface-raised px-2 py-0.5 text-[11px] text-secondary"
              >
                {citation[language]}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (preview.kind === ShowcasePreviewKind.SlidesTemplate) {
    const activePage = preview.pages[slideIndex] ?? preview.pages[0];
    return (
      <div className="flex h-full flex-col gap-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground/75">{t('pptStreamlinedBadge')}</span>
          <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-foreground/75">
            {t('pptStreamlinedPagesChip').replace('{count}', String(preview.slideCount))}
          </span>
        </div>

        {coverUrl && (
          <div className="overflow-hidden rounded-2xl border border-border/80 bg-surface shadow-card">
            <img
              src={coverUrl}
              alt={example.title[language]}
              className="aspect-[16/10] w-full object-cover"
            />
          </div>
        )}

        <div className="rounded-2xl border border-border bg-surface p-4 shadow-subtle">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">{activePage.heading[language]}</span>
            {activePage.statValue && (
              <span className="shrink-0 rounded-full bg-primary-muted px-2 py-0.5 text-[11px] font-semibold text-primary">
                {activePage.statValue}
              </span>
            )}
          </div>
          <ul className="mt-2 space-y-1 text-xs leading-5 text-secondary">
            {activePage.bullets.map((bullet, idx) => (
              <li key={idx}>• {bullet[language]}</li>
            ))}
          </ul>
          <div className="mt-3 grid grid-cols-4 gap-1.5" role="group" aria-label={t('pptStreamlinedStyleLabel')}>
            {preview.pages.map((page, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setSlideIndex(idx)}
                aria-pressed={slideIndex === idx}
                className={`rounded-lg border px-2 py-1.5 text-left text-[11px] font-medium transition-colors ${
                  slideIndex === idx
                    ? 'border-primary bg-primary-muted/75 text-primary'
                    : 'border-border/75 bg-surface-raised/60 text-secondary hover:text-foreground'
                }`}
              >
                <span className="block truncate">{page.label[language]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (preview.kind === ShowcasePreviewKind.DataDashboard) {
    const sampleFile = example.sampleFiles?.[0];
    return (
      <div className="flex h-full flex-col gap-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex rounded-xl border border-border bg-surface p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setViewMode('result')}
              className={`rounded-lg px-2.5 py-1 font-medium transition-colors ${
                viewMode === 'result' ? 'bg-primary-muted text-primary' : 'text-secondary hover:text-foreground'
              }`}
            >
              {t('homeShowcaseTabResult')}
            </button>
            {sampleFile && (
              <button
                type="button"
                onClick={() => setViewMode('raw')}
                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 font-medium transition-colors ${
                  viewMode === 'raw' ? 'bg-primary-muted text-primary' : 'text-secondary hover:text-foreground'
                }`}
              >
                <TableCellsIcon aria-hidden="true" className="h-3.5 w-3.5" />
                {t('homeShowcaseTabRawData')}
              </button>
            )}
          </div>
          <span className="text-xs text-foreground/60">{preview.kicker[language]}</span>
        </div>

        {viewMode === 'result' ? (
          <>
            {coverUrl && (
              <div className="overflow-hidden rounded-2xl border border-border/80 bg-surface shadow-card">
                <img
                  src={coverUrl}
                  alt={example.title[language]}
                  className="aspect-[16/10] w-full object-cover"
                />
              </div>
            )}
            <div className="flex-1 overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-subtle scrollbar-hidden">
              <div className="grid grid-cols-3 gap-2">
                {preview.metrics.map((metric, idx) => (
                  <div key={idx} className="rounded-xl border border-border/75 bg-surface-raised/60 p-2.5">
                    <p className="truncate text-[10.5px] text-secondary">{metric.label[language]}</p>
                    <p className="mt-0.5 truncate text-sm font-bold text-foreground">{metric.value}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-xs leading-5 text-foreground/85">
                {preview.insight[language]}
              </p>
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-card scrollbar-hidden">
            <p className="mb-2 text-xs font-medium text-foreground">{sampleFile?.name}</p>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-surface-raised/80 p-3 font-mono text-[11px] leading-5 text-foreground/85">
              {sampleFile?.content.split('\n').slice(0, 18).join('\n')}
            </pre>
          </div>
        )}
      </div>
    );
  }

  if (preview.kind === ShowcasePreviewKind.DocumentTransform) {
    return (
      <div className="flex h-full flex-col gap-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex rounded-xl border border-border bg-surface p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setViewMode('result')}
              className={`rounded-lg px-2.5 py-1 font-medium transition-colors ${
                viewMode === 'result' ? 'bg-primary-muted text-primary' : 'text-secondary hover:text-foreground'
              }`}
            >
              {t('homeShowcaseTabResult')}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('raw')}
              className={`rounded-lg px-2.5 py-1 font-medium transition-colors ${
                viewMode === 'raw' ? 'bg-primary-muted text-primary' : 'text-secondary hover:text-foreground'
              }`}
            >
              {t('homeShowcaseTabRawMaterial')}
            </button>
          </div>
          <span className="rounded bg-violet-500/12 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
            {preview.docTypeBadge[language]}
          </span>
        </div>

        {viewMode === 'result' ? (
          <>
            {coverUrl && (
              <div className="overflow-hidden rounded-2xl border border-border/80 bg-surface shadow-card">
                <img
                  src={coverUrl}
                  alt={example.title[language]}
                  className="aspect-[16/10] w-full object-cover"
                />
              </div>
            )}
            <div className="flex-1 overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-subtle scrollbar-hidden">
              <div className="space-y-2.5">
                {preview.sections.map((section, idx) => (
                  <div
                    key={idx}
                    className={`rounded-xl border p-3 ${
                      section.tone === 'warning'
                        ? 'border-rose-500/25 bg-rose-500/[0.06]'
                        : section.tone === 'success'
                          ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
                          : 'border-border/80 bg-surface-raised/50'
                    }`}
                  >
                    <p className="text-xs font-semibold text-foreground">{section.heading[language]}</p>
                    <ul className="mt-1.5 space-y-1 text-xs leading-5 text-foreground/80">
                      {section.items.map((item, itemIdx) => (
                        <li key={itemIdx}>• {item[language]}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-card scrollbar-hidden">
            <p className="mb-2 text-xs font-medium text-secondary">
              {example.sampleFiles?.[0]?.name ?? t('homeShowcaseTabRawMaterial')}
            </p>
            <div className="whitespace-pre-wrap rounded-xl border border-dashed border-border bg-surface-raised/70 p-4 text-xs leading-6 text-foreground/80">
              {example.sampleFiles?.[0]?.content ?? preview.rawInputExcerpt[language]}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Website live preview stage
  return (
    <div className="flex h-full flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-xl border border-border bg-surface p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setViewport('desktop')}
            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 font-medium transition-colors ${
              viewport === 'desktop' ? 'bg-primary-muted text-primary' : 'text-secondary hover:text-foreground'
            }`}
          >
            <ComputerDesktopIcon aria-hidden="true" className="h-3.5 w-3.5" />
            {t('homeShowcaseTabDesktop')}
          </button>
          <button
            type="button"
            onClick={() => setViewport('mobile')}
            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 font-medium transition-colors ${
              viewport === 'mobile' ? 'bg-primary-muted text-primary' : 'text-secondary hover:text-foreground'
            }`}
          >
            <DevicePhoneMobileIcon aria-hidden="true" className="h-3.5 w-3.5" />
            {t('homeShowcaseTabMobile')}
          </button>
        </div>
        {preview.publishable && (
          <span className="rounded-full bg-blue-500/12 px-2.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-300">
            {t('homeShowcasePublishableBadge')}
          </span>
        )}
      </div>

      <div className="flex flex-col items-center">
        {coverUrl && (
          <div
            className={`overflow-hidden rounded-2xl border border-border/80 bg-surface shadow-card transition-all duration-200 ${
              viewport === 'mobile' ? 'w-[240px]' : 'w-full'
            }`}
          >
            <img
              src={coverUrl}
              alt={example.title[language]}
              className={viewport === 'mobile' ? 'aspect-[4/5] w-full object-cover' : 'aspect-[16/10] w-full object-cover'}
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {preview.cards.map((card, idx) => (
          <div key={idx} className="rounded-xl border border-border/80 bg-surface p-3 shadow-subtle">
            <p className="truncate text-xs font-semibold text-foreground">{card.title[language]}</p>
            <p className="mt-0.5 truncate text-[11px] text-secondary">{card.meta[language]}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
