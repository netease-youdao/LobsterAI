import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  FolderOpenIcon,
  PlusIcon,
  PuzzlePieceIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  dispatchOpenEmbeddedPlugin,
  dshHostService,
  type DshHostStatusSnapshot,
  type DshPluginEntry,
  type DshPluginMutationResult,
} from '@/services/dshHost';
import { i18nService } from '@/services/i18n';

import { DshHostPhase, DshPluginSurface } from '../../../shared/dshEngine/hostConstants';
import Modal from '../common/Modal';
import {
  SettingsStatusBadge,
  SettingsStatusTone,
  SettingsSwitch,
} from '../settings/SettingsLayout';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_ITEM_TITLE_TEXT,
  SETTINGS_META_TEXT,
} from '../settings/settingsTypography';
import { DshPluginInstallModal } from './DshPluginInstallModal';
import {
  formatPluginVersion,
  isHostPhaseHealthy,
  partitionPlugins,
  resolveHostPhaseLabelKey,
  resolveMutationErrorMessage,
  resolvePluginDisplayDescription,
  resolvePluginDisplayTitle,
} from './pluginViewModel';

export const DshPluginEcosystemView: React.FC = () => {
  const t = (key: string) => i18nService.t(key);
  const language = i18nService.getLanguage() === 'en' ? 'en' : 'zh';

  const [status, setStatus] = useState<DshHostStatusSnapshot | null>(null);
  const [plugins, setPlugins] = useState<DshPluginEntry[]>([]);
  const [cliShimPath, setCliShimPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [busyPlugin, setBusyPlugin] = useState<string | null>(null);

  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<DshPluginEntry | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [coreExpanded, setCoreExpanded] = useState(false);
  const [copiedCli, setCopiedCli] = useState(false);

  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const moreMenuRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const [nextStatus, pluginRes] = await Promise.all([
        dshHostService.getStatus(),
        dshHostService.listPlugins(),
      ]);
      setStatus(nextStatus);
      setPlugins(pluginRes.plugins ?? []);
      setCliShimPath(pluginRes.cliShimPath ?? nextStatus?.cliShimPath ?? null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
      if (isManual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!moreMenuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [moreMenuOpen]);

  const { userPlugins, coreComponents } = useMemo(() => partitionPlugins(plugins), [plugins]);

  const applyMutationFeedback = (res: DshPluginMutationResult, appliedMessageKey: string) => {
    if (res.plugins) {
      setPlugins(res.plugins);
    }
    if (res.restartRequired) {
      setRestartRequired(true);
      setNoticeMessage(null);
    } else {
      setNoticeMessage(t(appliedMessageKey));
    }
  };

  const handleInstalled = (res: DshPluginMutationResult) => {
    setErrorMessage(null);
    applyMutationFeedback(res, 'dshPluginsInstalledHot');
    void refresh();
  };

  const handleToggleEnabled = async (plugin: DshPluginEntry, nextEnabled: boolean) => {
    if (busyPlugin || restarting) return;
    setBusyPlugin(plugin.name);
    setErrorMessage(null);
    setNoticeMessage(null);
    try {
      const res = await dshHostService.setPluginEnabled(plugin.name, nextEnabled);
      if (!res.ok) {
        setErrorMessage(resolveMutationErrorMessage(res, 'dshEcosystemToggleFailed', t));
      } else {
        applyMutationFeedback(
          res,
          nextEnabled ? 'dshPluginsEnabledHot' : 'dshPluginsDisabledHot',
        );
      }
      await refresh();
    } finally {
      setBusyPlugin(null);
    }
  };

  const handleConfirmRemove = async () => {
    if (!removeTarget || busyPlugin || restarting) return;
    const targetName = removeTarget.name;
    setRemoveTarget(null);
    setBusyPlugin(targetName);
    setErrorMessage(null);
    setNoticeMessage(null);
    try {
      const res = await dshHostService.removePlugin(targetName);
      if (!res.ok) {
        setErrorMessage(resolveMutationErrorMessage(res, 'dshEcosystemRemoveFailed', t));
      } else {
        applyMutationFeedback(res, 'dshPluginsRemovedHot');
      }
      await refresh();
    } finally {
      setBusyPlugin(null);
    }
  };

  const handleOpenWebView = async (routeHash?: string) => {
    setMoreMenuOpen(false);
    setErrorMessage(null);
    const res = await dshHostService.openEcosystemView(routeHash);
    if (!res.ok && res.error) {
      setErrorMessage(res.error);
    }
  };

  const handleRestart = async () => {
    if (restarting) return;
    setMoreMenuOpen(false);
    setRestarting(true);
    setErrorMessage(null);
    setNoticeMessage(null);
    try {
      const res = await dshHostService.restart();
      if (!res.ok) {
        setErrorMessage(res.error || t('dshPluginsRestartFailed'));
      } else {
        setRestartRequired(false);
        setNoticeMessage(t('dshPluginsRestartedSuccess'));
      }
      await refresh();
    } finally {
      setRestarting(false);
    }
  };

  const handleCopyCliPath = async () => {
    if (!cliShimPath) return;
    const res = await dshHostService.copyCliShimCommand();
    if (res.ok) {
      setCopiedCli(true);
      setTimeout(() => {
        setCopiedCli(false);
        setMoreMenuOpen(false);
      }, 900);
    }
  };

  const handleOpenProfileDir = () => {
    setMoreMenuOpen(false);
    void dshHostService.openProfileDir();
  };

  const hostHealthy = isHostPhaseHealthy(status?.phase);
  const statusDotClass =
    status?.phase === DshHostPhase.Ready
      ? 'bg-emerald-500'
      : status?.phase === DshHostPhase.Failed
        ? 'bg-red-500'
        : 'bg-amber-400 animate-pulse';

  return (
    <div className="space-y-5">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className={`min-w-0 flex-1 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
          {t('dshPluginsPageSubtitle')}
        </p>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setInstallModalOpen(true)}
            disabled={restarting}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-primary-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlusIcon className="h-3.5 w-3.5 stroke-[2.2]" />
            {t('dshEcosystemInstallBtn')}
          </button>

          <div ref={moreMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setMoreMenuOpen((prev) => !prev)}
              aria-haspopup="menu"
              aria-expanded={moreMenuOpen}
              aria-label={t('dshPluginsMoreActions')}
              title={t('dshPluginsMoreActions')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <EllipsisHorizontalIcon className="h-4 w-4" />
            </button>

            {moreMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 z-30 mt-1.5 w-60 rounded-xl border border-border bg-surface p-1 shadow-popover"
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={refreshing}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    void refresh(true);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
                >
                  <ArrowPathIcon className={`h-3.5 w-3.5 text-secondary ${refreshing ? 'animate-spin' : ''}`} />
                  {t('dshPluginsRefresh')}
                </button>

                <div className="my-1 border-t border-border" />

                {status && (
                  <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] text-secondary">
                    <span className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
                      {t(resolveHostPhaseLabelKey(status.phase))}
                    </span>
                    <span className="font-mono opacity-80">
                      DSH {status.runtimeVersion ?? '0.2.2-rc.5'}
                    </span>
                  </div>
                )}

                <button
                  type="button"
                  role="menuitem"
                  disabled={restarting}
                  onClick={() => void handleRestart()}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
                >
                  <ArrowPathIcon className={`h-3.5 w-3.5 text-secondary ${restarting ? 'animate-spin' : ''}`} />
                  {restarting ? t('dshPluginsRestarting') : t('dshEcosystemRestartHost')}
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={handleOpenProfileDir}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-surface-raised"
                >
                  <FolderOpenIcon className="h-3.5 w-3.5 text-secondary" />
                  {t('dshPluginsOpenDataDir')}
                </button>

                {cliShimPath && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleCopyCliPath()}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-surface-raised"
                  >
                    {copiedCli
                      ? <CheckIcon className="h-3.5 w-3.5 text-emerald-500" />
                      : <ClipboardDocumentIcon className="h-3.5 w-3.5 text-secondary" />}
                    {copiedCli ? t('dshPluginsCliCopied') : t('dshPluginsCopyCliPath')}
                  </button>
                )}

                <div className="my-1 border-t border-border" />

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleOpenWebView()}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-raised"
                >
                  <ArrowTopRightOnSquareIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-secondary" />
                  <div className="min-w-0">
                    <div className="text-xs text-foreground">{t('dshPluginsOpenAdvancedWeb')}</div>
                    <div className="text-[11px] text-secondary">{t('dshPluginsOpenAdvancedWebDesc')}</div>
                  </div>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Conditional Engine Unhealthy Banner */}
      {status && !hostHealthy && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-400/50 bg-amber-50/80 px-3.5 py-2.5 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
          <div className="flex min-w-0 items-center gap-2">
            <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="truncate">
              {t('dshPluginsEngineUnhealthyBanner').replace(
                '{status}',
                t(resolveHostPhaseLabelKey(status.phase)),
              )}
            </span>
          </div>
          {status.phase === DshHostPhase.Failed && (
            <button
              type="button"
              disabled={restarting}
              onClick={() => void handleRestart()}
              className="shrink-0 rounded-lg border border-current/25 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-current/10 disabled:opacity-50"
            >
              {restarting ? t('dshPluginsRestarting') : t('dshEcosystemRestartHost')}
            </button>
          )}
        </div>
      )}

      {/* Conditional Restart-Required Banner (only shown when HMR cannot hot-apply) */}
      {restartRequired && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-400/50 bg-amber-50/80 px-3.5 py-2.5 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
          <div className="flex min-w-0 items-center gap-2">
            <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>{t('dshPluginsRestartRequiredBanner')}</span>
          </div>
          <button
            type="button"
            disabled={restarting}
            onClick={() => void handleRestart()}
            className="shrink-0 rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
          >
            {restarting ? t('dshPluginsRestarting') : t('dshPluginsRestartNow')}
          </button>
        </div>
      )}

      {/* Feedback Banners */}
      {noticeMessage && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          <span>{noticeMessage}</span>
          <button
            type="button"
            onClick={() => setNoticeMessage(null)}
            className="rounded p-0.5 opacity-70 hover:opacity-100"
            aria-label={t('close')}
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {errorMessage && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-red-300/70 bg-red-50 px-3.5 py-2.5 text-xs text-red-700 dark:border-red-800/70 dark:bg-red-950/35 dark:text-red-300">
          <span className="min-w-0 break-words">{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
            aria-label={t('close')}
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* User Installed Plugins Section */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between px-1">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-secondary">
            {t('dshPluginsInstalledHeading')}
            {userPlugins.length > 0 ? ` (${userPlugins.length})` : ''}
          </h4>
        </div>

        {loading ? (
          <div className="rounded-xl border border-border bg-surface px-4 py-8 text-center text-xs text-secondary">
            <ArrowPathIcon className="mx-auto mb-2 h-4 w-4 animate-spin text-secondary" />
            {t('dshPluginsLoading')}
          </div>
        ) : userPlugins.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface/50 px-6 py-10 text-center">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-surface-raised text-secondary">
              <PuzzlePieceIcon className="h-5 w-5" />
            </span>
            <h5 className={`mt-3 font-medium text-foreground ${SETTINGS_ITEM_TITLE_TEXT}`}>
              {t('dshPluginsEmptyTitle')}
            </h5>
            <p className={`mt-1 max-w-md ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
              {t('dshPluginsEmptyDesc')}
            </p>
            <button
              type="button"
              onClick={() => setInstallModalOpen(true)}
              className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              {t('dshEcosystemInstallBtn')}
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-xl border border-border bg-surface">
            {userPlugins.map((plugin) => {
              const isBusy = busyPlugin === plugin.name;
              const title = resolvePluginDisplayTitle(plugin, language, t);
              const description = resolvePluginDisplayDescription(plugin, language);
              const versionLabel = formatPluginVersion(plugin.version);
              const showPackageNameSub = title !== plugin.name;
              const isHybrid = plugin.surface === DshPluginSurface.Hybrid;
              const isWebOnly = plugin.surface === DshPluginSurface.WebOnly;

              return (
                <div
                  key={plugin.name}
                  className="flex items-start justify-between gap-4 px-4 py-3.5"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    {/* Plugin Icon */}
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-raised">
                      {plugin.icon ? (
                        <img
                          src={plugin.icon}
                          alt=""
                          className="h-6 w-6 object-contain"
                        />
                      ) : (
                        <PuzzlePieceIcon className="h-4 w-4 text-secondary" />
                      )}
                    </div>

                    {/* Plugin Info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`truncate font-medium text-foreground ${SETTINGS_ITEM_TITLE_TEXT}${
                            plugin.enabled ? '' : ' opacity-60'
                          }`}
                        >
                          {title}
                        </span>
                        {versionLabel && (
                          <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-secondary">
                            {versionLabel}
                          </span>
                        )}
                        {isHybrid && (
                          <span
                            title={t('dshPluginsHybridTooltip')}
                            className="rounded-full bg-primary-muted px-2 py-0.5 text-[11px] font-medium text-primary"
                          >
                            {t('dshPluginsBadgeHybrid')}
                          </span>
                        )}
                        {isWebOnly && (
                          <span
                            title={t('dshPluginsWebOnlyTooltip')}
                            className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
                          >
                            {plugin.isThemePlugin
                              ? t('dshPluginsBadgeWebTheme')
                              : t('dshPluginsBadgeWebOnly')}
                          </span>
                        )}
                        {plugin.errorCode && (
                          <SettingsStatusBadge
                            tone={SettingsStatusTone.Danger}
                            label={t('dshPluginsBadgeError')}
                            title={plugin.errorMessage || plugin.errorCode}
                          />
                        )}
                      </div>

                      {description && (
                        <p className={`mt-0.5 line-clamp-2 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                          {description}
                        </p>
                      )}

                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        {showPackageNameSub && (
                          <span className={`truncate font-mono ${SETTINGS_META_TEXT} text-secondary/80`}>
                            {plugin.name}
                          </span>
                        )}
                        {plugin.enabled && plugin.panelId && !plugin.isThemePlugin && (
                          <button
                            type="button"
                            onClick={() => {
                              dispatchOpenEmbeddedPlugin({
                                name: plugin.name,
                                panelId: plugin.panelId!,
                                title,
                                ...(plugin.icon ? { icon: plugin.icon } : {}),
                              });
                            }}
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                          >
                            {t('dshPluginsOpenPluginPanel')}
                          </button>
                        )}
                      </div>

                      {plugin.errorMessage && (
                        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                          {plugin.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Plugin Actions */}
                  <div className="flex shrink-0 items-center gap-2 pt-0.5">
                    {isBusy && (
                      <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-secondary" />
                    )}
                    <SettingsSwitch
                      checked={plugin.enabled}
                      label={plugin.enabled ? t('dshEcosystemDisableLabel') : t('dshEcosystemEnableLabel')}
                      disabled={busyPlugin !== null || restarting}
                      onClick={() => handleToggleEnabled(plugin, !plugin.enabled)}
                    />
                    {plugin.removable !== false && (
                      <button
                        type="button"
                        disabled={busyPlugin !== null || restarting}
                        onClick={() => setRemoveTarget(plugin)}
                        title={t('dshEcosystemRemoveBtn')}
                        aria-label={t('dshEcosystemRemoveBtn')}
                        className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-red-950/30 dark:hover:text-red-400"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Collapsed System Core Components (read-only, hidden by default) */}
      {coreComponents.length > 0 && (
        <section className="pt-1">
          <button
            type="button"
            onClick={() => setCoreExpanded((prev) => !prev)}
            className="inline-flex items-center gap-1.5 px-1 text-xs font-medium text-secondary transition-colors hover:text-foreground"
          >
            {coreExpanded
              ? <ChevronDownIcon className="h-3.5 w-3.5" />
              : <ChevronRightIcon className="h-3.5 w-3.5" />}
            <span>
              {t('dshPluginsCoreComponentsToggle').replace('{count}', String(coreComponents.length))}
            </span>
          </button>

          {coreExpanded && (
            <div className="mt-2 divide-y divide-border rounded-xl border border-border bg-surface/60">
              {coreComponents.map((component) => {
                const label = resolvePluginDisplayTitle(component, language, t);
                const versionLabel = formatPluginVersion(component.version);
                return (
                  <div
                    key={component.name}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-foreground">{label}</span>
                        {versionLabel && (
                          <span className="font-mono text-[11px] text-secondary">{versionLabel}</span>
                        )}
                      </div>
                      {label !== component.name && (
                        <div className="truncate font-mono text-[11px] text-secondary/75">
                          {component.name}
                        </div>
                      )}
                    </div>
                    <span className="shrink-0 rounded-full bg-surface-raised px-2 py-0.5 text-[11px] text-secondary">
                      {t('dshEcosystemManagedBadge')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Install Modal */}
      <DshPluginInstallModal
        isOpen={installModalOpen}
        onClose={() => setInstallModalOpen(false)}
        onInstalled={handleInstalled}
      />

      {/* Remove Confirmation Modal */}
      <Modal
        isOpen={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onEscape={() => setRemoveTarget(null)}
        overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-modal"
      >
        <h3 className="text-base font-semibold text-foreground">{t('dshPluginsRemoveConfirmTitle')}</h3>
        <p className={`mt-2 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
          {t('dshPluginsRemoveConfirmDesc').replace(
            '{name}',
            removeTarget ? resolvePluginDisplayTitle(removeTarget, language, t) : '',
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setRemoveTarget(null)}
            className="rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleConfirmRemove()}
            className="rounded-xl bg-red-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700"
          >
            {t('dshEcosystemRemoveBtn')}
          </button>
        </div>
      </Modal>
    </div>
  );
};
