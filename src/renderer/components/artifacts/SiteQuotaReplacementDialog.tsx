import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import { type SiteDeploymentQuota, SiteKind, type SiteQuotaCandidate } from '@shared/site/constants';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';

const t = (key: string) => i18nService.t(key);

interface SiteQuotaReplacementDialogProps {
  quota: SiteDeploymentQuota;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onQuery: (keyword: string, page: number) => void;
  onStopAndContinue: (candidate: SiteQuotaCandidate) => void;
}

const SiteQuotaReplacementDialog: React.FC<SiteQuotaReplacementDialogProps> = ({
  quota,
  busy,
  error,
  onClose,
  onQuery,
  onStopAndContinue,
}) => {
  const [keyword, setKeyword] = useState('');
  const [selectedShareId, setSelectedShareId] = useState<string>();
  const [confirmCandidate, setConfirmCandidate] = useState<SiteQuotaCandidate>();
  const pageCount = Math.max(
    1,
    Math.ceil(quota.candidates.total / Math.max(1, quota.candidates.pageSize)),
  );
  const selected = quota.candidates.list.find(candidate => candidate.shareId === selectedShareId);

  useEffect(() => {
    if (
      selectedShareId
      && !quota.candidates.list.some(candidate => candidate.shareId === selectedShareId)
    ) {
      setSelectedShareId(undefined);
    }
  }, [quota.candidates.list, selectedShareId]);

  return createPortal(
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-quota-dialog-title"
        className="flex max-h-[86vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        <div className="shrink-0 px-6 pb-4 pt-5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
              <ExclamationTriangleIcon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="site-quota-dialog-title" className="text-lg font-semibold text-foreground">
                {t('siteQuotaTitle')}
              </h2>
              <p className="mt-1 text-sm leading-5 text-secondary">
                {t('siteQuotaDescription')
                  .replace('{plan}', quota.plan.displayName || quota.plan.name)
                  .replace('{limit}', String(quota.usage.limit))}
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between rounded-xl bg-surface px-4 py-3 text-sm">
            <span className="text-secondary">{t('siteQuotaUsage')}</span>
            <span className="font-medium text-foreground">
              {t('siteQuotaUsageValue')
                .replace('{used}', String(quota.usage.used))
                .replace('{limit}', String(quota.usage.limit))}
            </span>
          </div>
          {quota.usage.requiredStops > 1 && (
            <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-200">
              {t('siteQuotaRequiredStops').replace(
                '{count}',
                String(quota.usage.requiredStops),
              )}
            </p>
          )}
          {quota.usage.reserved > 0 && (
            <p className="mt-2 text-xs leading-5 text-secondary">
              {t('siteQuotaReservedHint').replace('{count}', String(quota.usage.reserved))}
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-6 py-4">
          <div className="flex items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <MagnifyingGlassIcon
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
                aria-hidden="true"
              />
              <input
                value={keyword}
                onChange={event => setKeyword(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') onQuery(keyword, 1);
                }}
                placeholder={t('siteQuotaSearchPlaceholder')}
                className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none focus:border-primary"
              />
            </label>
            <button
              type="button"
              onClick={() => onQuery(keyword, 1)}
              disabled={busy}
              className="h-9 rounded-lg border border-border px-3 text-sm text-secondary hover:bg-surface disabled:opacity-50"
            >
              {t('search')}
            </button>
          </div>

          <p className="mt-4 text-xs text-secondary">{t('siteQuotaChooseHint')}</p>
          <div className="mt-2 space-y-2">
            {quota.candidates.list.map(candidate => (
              <label
                key={candidate.shareId}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 transition-colors ${
                  selectedShareId === candidate.shareId
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-surface'
                }`}
              >
                <input
                  type="radio"
                  name="site-quota-candidate"
                  checked={selectedShareId === candidate.shareId}
                  onChange={() => setSelectedShareId(candidate.shareId)}
                  disabled={busy}
                  className="h-4 w-4 shrink-0 accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{candidate.title}</div>
                  <div className="mt-1 truncate text-xs text-secondary">{candidate.url}</div>
                </div>
                <span className="shrink-0 rounded-full bg-surface px-2 py-1 text-xs text-secondary">
                  {candidate.siteKind === SiteKind.StaticSite
                    ? t('sitesStaticSite')
                    : t('sitesNodeService')}
                </span>
              </label>
            ))}
            {quota.candidates.list.length === 0 && (
              <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-secondary">
                {t('siteQuotaNoCandidates')}
              </div>
            )}
          </div>

          {pageCount > 1 && (
            <div className="mt-3 flex items-center justify-end gap-2 text-xs text-secondary">
              <button
                type="button"
                onClick={() => onQuery(keyword, quota.candidates.page - 1)}
                disabled={busy || quota.candidates.page <= 1}
                className="rounded-md border border-border px-2 py-1 disabled:opacity-40"
              >
                {t('sitesPreviousPage')}
              </button>
              <span>{quota.candidates.page} / {pageCount}</span>
              <button
                type="button"
                onClick={() => onQuery(keyword, quota.candidates.page + 1)}
                disabled={busy || quota.candidates.page >= pageCount}
                className="rounded-md border border-border px-2 py-1 disabled:opacity-40"
              >
                {t('sitesNextPage')}
              </button>
            </div>
          )}

          {error && <p className="mt-3 text-xs text-red-500" role="alert">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-9 rounded-lg border border-border px-4 text-sm text-secondary hover:bg-surface disabled:opacity-50"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => selected && setConfirmCandidate(selected)}
            disabled={busy || !selected}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {t('siteQuotaStopAndContinue')}
          </button>
        </div>
      </div>

      {confirmCandidate && (
        <div className="fixed inset-0 z-[10030] flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-[420px] rounded-2xl border border-border bg-background p-6 shadow-2xl">
            <h3 className="text-base font-semibold text-foreground">{t('siteQuotaConfirmTitle')}</h3>
            <p className="mt-2 text-sm leading-6 text-secondary">
              {t('siteQuotaConfirmDescription').replace('{name}', confirmCandidate.title)}
            </p>
            {confirmCandidate.siteKind === SiteKind.NodeService && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200">
                {t('siteQuotaNodeStopWarning')}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmCandidate(undefined)}
                disabled={busy}
                className="h-9 rounded-lg border border-border px-4 text-sm text-secondary hover:bg-surface disabled:opacity-50"
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => onStopAndContinue(confirmCandidate)}
                disabled={busy}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy && <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {t('siteQuotaConfirmStop')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
};

export default SiteQuotaReplacementDialog;
