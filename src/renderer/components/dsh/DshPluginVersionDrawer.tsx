import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import React, { useState } from 'react';

import { i18nService } from '@/services/i18n';

import {
  formatIncompatibleRequirements,
  formatPluginCheckedTime,
  formatPluginPublishedDate,
  isPluginVersionInstallable,
  pickRecommendedPluginUpdate,
  type PluginVersionCheckState,
  resolveRegistryAttemptProblemText,
} from './pluginUpdateViewModel';
import { formatPluginVersion, formatRegistryDisplayName } from './pluginViewModel';

interface DshPluginVersionDrawerProps {
  installedVersion?: string;
  check?: PluginVersionCheckState;
  disabled: boolean;
  onRecheck: () => void;
  onSelectUpdate: (version: string, registry?: string | null) => void;
}

export const DshPluginVersionDrawer: React.FC<DshPluginVersionDrawerProps> = ({
  installedVersion,
  check,
  disabled,
  onRecheck,
  onSelectUpdate,
}) => {
  const t = (key: string) => i18nService.t(key);
  const [showPrereleases, setShowPrereleases] = useState(false);

  const isChecking = !check || check.phase === 'checking';
  const done = check?.phase === 'done' ? check : null;
  const listed = done?.list.status === 'listed' ? done.list : null;
  const refused = done?.list.status === 'refused' ? done.list : null;
  const recommended = listed ? pickRecommendedPluginUpdate(listed) : undefined;
  const hasPrereleases = listed ? listed.versions.some((v) => v.prerelease) : false;
  const visibleVersions = listed
    ? listed.versions.filter((v) => showPrereleases || !v.prerelease)
    : [];
  const blockedStable = listed
    ? listed.versions.find((v) => !v.prerelease && v.incompatible !== undefined)?.incompatible
    : undefined;

  const summary = (() => {
    if (isChecking) {
      return {
        tone: 'neutral' as const,
        title: t('dshPluginsVersionsChecking'),
        sub: null as string | null,
      };
    }
    if (refused) {
      const lastAttempt = refused.attempts[refused.attempts.length - 1];
      const sub = lastAttempt?.problem
        ? `${formatRegistryDisplayName(lastAttempt.registry, t)}: ${resolveRegistryAttemptProblemText(lastAttempt.problem, t)}`
        : refused.reason;
      return {
        tone: 'error' as const,
        title: t(
          refused.problem === 'network'
            ? 'dshPluginsVersionsFailedNetwork'
            : 'dshPluginsVersionsFailedOther',
        ),
        sub,
      };
    }
    if (recommended) {
      const date = formatPluginPublishedDate(recommended.publishedAt);
      const versionLabel = formatPluginVersion(recommended.version) ?? recommended.version;
      return {
        tone: 'info' as const,
        title: t('dshPluginsVersionsAvailable').replace('{version}', versionLabel),
        sub: date ? t('dshPluginsVersionsPublishedAt').replace('{date}', date) : null,
      };
    }
    if (listed && listed.versions.length === 0) {
      return {
        tone: 'success' as const,
        title: t('dshPluginsVersionsLatest'),
        sub: done
          ? t('dshPluginsVersionsCheckedAt').replace('{time}', formatPluginCheckedTime(done.checkedAt))
          : null,
      };
    }
    if (blockedStable) {
      return {
        tone: 'warn' as const,
        title: t('dshPluginsVersionsBlocked'),
        sub: t('dshPluginsVersionsBlockedDetail')
          .replace('{version}', formatPluginVersion(blockedStable.version) ?? blockedStable.version)
          .replace('{peers}', formatIncompatibleRequirements(blockedStable))
          .replace('{runtime}', blockedStable.runtimeVersion),
      };
    }
    return {
      tone: 'warn' as const,
      title: t('dshPluginsVersionsNoneInstallable'),
      sub: null,
    };
  })();

  const currentVersionDisplay =
    formatPluginVersion(listed?.installed ?? installedVersion) ?? (listed?.installed ?? installedVersion ?? '');

  return (
    <div className="mt-3 rounded-xl border border-border bg-background/60 p-3 text-xs space-y-2.5">
      {/* Drawer Summary Row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 shrink-0">
            {isChecking ? (
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-secondary" />
            ) : summary.tone === 'info' ? (
              <ArrowDownTrayIcon className="h-3.5 w-3.5 text-foreground" />
            ) : summary.tone === 'success' ? (
              <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-500" />
            ) : summary.tone === 'warn' ? (
              <ExclamationTriangleIcon className="h-3.5 w-3.5 text-amber-500" />
            ) : (
              <ExclamationCircleIcon className="h-3.5 w-3.5 text-red-500" />
            )}
          </span>
          <div className="min-w-0">
            <div className="font-medium text-foreground">{summary.title}</div>
            {summary.sub && (
              <div className="mt-0.5 text-[11px] text-secondary break-words">{summary.sub}</div>
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={isChecking || disabled}
          onClick={onRecheck}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-[11px] font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowPathIcon className={`h-3 w-3 ${isChecking ? 'animate-spin' : ''}`} />
          {refused ? t('retry') : t('dshPluginsVersionsRecheck')}
        </button>
      </div>

      {/* Listed Versions */}
      {listed && (
        <div className="space-y-2">
          {(visibleVersions.length > 0 || currentVersionDisplay) && (
            <ul className="divide-y divide-border/70 rounded-lg border border-border bg-surface">
              {visibleVersions.map((item) => {
                const installable = isPluginVersionInstallable(item);
                const versionLabel = formatPluginVersion(item.version) ?? item.version;
                const publishedDate = formatPluginPublishedDate(item.publishedAt);
                const note = item.incompatible
                  ? t('dshPluginsVersionsNeedsDsh').replace(
                      '{peers}',
                      formatIncompatibleRequirements(item.incompatible),
                    )
                  : !item.bundle
                    ? t('dshPluginsVersionsNotBundle')
                    : item.deprecated;
                const isRecommended = recommended?.version === item.version;

                return (
                  <li
                    key={item.version}
                    className={`flex items-start justify-between gap-3 px-3 py-2 ${
                      installable ? '' : 'opacity-65'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono font-medium text-foreground">
                          {versionLabel}
                        </span>
                        {item.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary"
                          >
                            {tag}
                          </span>
                        ))}
                        {item.prerelease && (
                          <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                            {t('dshPluginsVersionsPrereleaseTag')}
                          </span>
                        )}
                        {item.deprecated && (
                          <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                            {t('dshPluginsVersionsDeprecatedTag')}
                          </span>
                        )}
                        {publishedDate && (
                          <span className="text-[11px] text-secondary/80">{publishedDate}</span>
                        )}
                      </div>
                      {note && (
                        <p
                          className={`mt-0.5 text-[11px] break-words ${
                            installable && item.deprecated
                              ? 'text-amber-700 dark:text-amber-300'
                              : 'text-secondary'
                          }`}
                        >
                          {note}
                        </p>
                      )}
                    </div>

                    {installable && item.version !== listed.installed && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onSelectUpdate(item.version, listed.registry)}
                        className={`shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                          isRecommended
                            ? 'bg-action text-action-foreground hover:bg-action-hover'
                            : 'border border-border bg-surface text-foreground hover:bg-surface-raised'
                        }`}
                      >
                        {t('dshPluginsUpdateBtn')}
                      </button>
                    )}
                  </li>
                );
              })}

              {currentVersionDisplay && (
                <li className="flex items-center justify-between gap-2 px-3 py-2 text-secondary">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono">{currentVersionDisplay}</span>
                    <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium">
                      {t('dshPluginsVersionsInstalledTag')}
                    </span>
                  </div>
                </li>
              )}
            </ul>
          )}

          {listed.omitted > 0 && (
            <p className="text-[11px] text-secondary">
              {t('dshPluginsVersionsOmitted').replace('{count}', String(listed.omitted))}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-secondary">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                {t('dshPluginsVersionsRegistryLabel')}:{' '}
                <span className="text-foreground">
                  {formatRegistryDisplayName(listed.registry, t)}
                </span>
                {listed.attempts.length > 1 && (
                  <span className="ml-1 rounded bg-surface-raised px-1 py-0.5 text-[10px]">
                    {t('dshPluginsVersionsFallbackTag')}
                  </span>
                )}
              </span>
              {done && (
                <span>
                  {t('dshPluginsVersionsCheckedAt').replace(
                    '{time}',
                    formatPluginCheckedTime(done.checkedAt),
                  )}
                </span>
              )}
            </div>

            {hasPrereleases && (
              <label className="inline-flex cursor-pointer items-center gap-1.5 select-none text-secondary hover:text-foreground">
                <input
                  type="checkbox"
                  checked={showPrereleases}
                  onChange={(event) => setShowPrereleases(event.target.checked)}
                  className="h-3.5 w-3.5 rounded border-border accent-action"
                />
                <span>{t('dshPluginsVersionsShowPrerelease')}</span>
              </label>
            )}
          </div>
        </div>
      )}

      {/* Refused Registry Attempts */}
      {refused && refused.attempts.length > 0 && (
        <ul className="divide-y divide-border/70 rounded-lg border border-border bg-surface">
          {refused.attempts.map((attempt, index) => (
            <li
              key={`${String(attempt.registry)}-${index}`}
              className="space-y-1 px-3 py-2 text-[11px]"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-foreground">
                  {formatRegistryDisplayName(attempt.registry, t)}
                </span>
                <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary">
                  {t(
                    index === 0
                      ? 'dshPluginsVersionsPrimaryTag'
                      : 'dshPluginsVersionsFallbackTag',
                  )}
                </span>
                {attempt.problem && (
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
                    {resolveRegistryAttemptProblemText(attempt.problem, t)}
                  </span>
                )}
              </div>
              {attempt.reason && (
                <pre className="overflow-x-auto font-mono text-[10px] text-secondary whitespace-pre-wrap break-all">
                  {attempt.reason}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
