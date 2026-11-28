import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CpuChipIcon,
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
  DEFAULT_DSH_AGENT_PRESET_SETTINGS,
  dispatchOpenEmbeddedPlugin,
  DSH_AGENT_PRESET_SETTINGS_CHANGED_EVENT,
  DSH_PLUGIN_ORDER_CHANGED_EVENT,
  type DshAgentPresetSettings,
  dshHostService,
  type DshHostStatusSnapshot,
  type DshPluginEntry,
  type DshPluginMutationResult,
  type DshPluginOrderChangedDetail,
  type DshPluginUpdateOutcome,
  type DshPluginVersionList,
  loadDshAgentPresetSettings,
  loadDshPluginOrder,
  saveDshPluginOrder,
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
import { DshAdvancedRuntimeModeModal } from './DshAdvancedRuntimeModeModal';
import {
  BackgroundInstallOutcome,
  DshPluginInstallModal,
} from './DshPluginInstallModal';
import {
  DshPluginUpdateModal,
  type DshPluginUpdateTarget,
} from './DshPluginUpdateModal';
import { DshPluginVersionDrawer } from './DshPluginVersionDrawer';
import {
  BatchUpdateCheckSummaryTone,
  dropStaleVersionChecks,
  getPluginRecommendedVersion,
  getPluginVersionCheckRegistry,
  isRegistryUpdatablePlugin,
  type PluginVersionCheckState,
  summarizeBatchUpdateCheck,
} from './pluginUpdateViewModel';
import {
  formatPluginVersion,
  isHostPhaseHealthy,
  MAX_VISIBLE_SIDEBAR_PLUGIN_PANELS,
  partitionPlugins,
  resolveHostPhaseLabelKey,
  resolveMutationErrorMessage,
  resolvePluginDisplayDescription,
  resolvePluginDisplayTitle,
  resolveSidebarPluginPlacement,
  SidebarPluginPlacement,
  sortPluginsByDisplayOrder,
} from './pluginViewModel';
import { SortablePluginRow } from './SortablePluginRow';

export const DshPluginEcosystemView: React.FC = () => {
  const t = (key: string) => i18nService.t(key);
  const language = i18nService.getLanguage() === 'en' ? 'en' : 'zh';

  const [status, setStatus] = useState<DshHostStatusSnapshot | null>(null);
  const [plugins, setPlugins] = useState<DshPluginEntry[]>([]);
  const [pluginOrder, setPluginOrder] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [busyPlugin, setBusyPlugin] = useState<string | null>(null);

  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [installTaskActive, setInstallTaskActive] = useState(false);
  const [highlightedPlugin, setHighlightedPlugin] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<DshPluginEntry | null>(null);
  const [updateTarget, setUpdateTarget] = useState<DshPluginUpdateTarget | null>(null);
  const [versionChecks, setVersionChecks] = useState<Record<string, PluginVersionCheckState>>({});
  const [checkingAllUpdates, setCheckingAllUpdates] = useState(false);
  const [expandedVersions, setExpandedVersions] = useState<Record<string, boolean>>({});
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [runtimeModeModalOpen, setRuntimeModeModalOpen] = useState(false);
  const [runtimeModeEnabled, setRuntimeModeEnabled] = useState(DEFAULT_DSH_AGENT_PRESET_SETTINGS.enabled);
  const [coreExpanded, setCoreExpanded] = useState(false);

  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const moreMenuRef = useRef<HTMLDivElement>(null);
  const versionChecksRef = useRef(versionChecks);
  versionChecksRef.current = versionChecks;
  const updateTargetRef = useRef(updateTarget);
  updateTargetRef.current = updateTarget;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void loadDshAgentPresetSettings().then((loaded) => {
      if (active) setRuntimeModeEnabled(loaded.enabled);
    });
    const onSettingsChanged = (event: Event) => {
      const detail = (event as CustomEvent<DshAgentPresetSettings>).detail;
      if (active && detail) setRuntimeModeEnabled(detail.enabled);
    };
    window.addEventListener(DSH_AGENT_PRESET_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    return () => {
      active = false;
      window.removeEventListener(DSH_AGENT_PRESET_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    };
  }, []);

  const refresh = useCallback(async (): Promise<DshPluginEntry[]> => {
    try {
      const [nextStatus, pluginRes] = await Promise.all([
        dshHostService.getStatus(),
        dshHostService.listPlugins(),
      ]);
      if (!mountedRef.current) return [];
      const nextPlugins = pluginRes.plugins ?? [];
      setStatus(nextStatus);
      setPlugins(nextPlugins);
      setVersionChecks((prev) => dropStaleVersionChecks(nextPlugins, prev));
      return nextPlugins;
    } catch (error) {
      if (mountedRef.current) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
      return [];
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let active = true;
    void loadDshPluginOrder().then((order) => {
      if (active) setPluginOrder(order);
    });
    const handleOrderChanged = (event: Event) => {
      const detail = (event as CustomEvent<DshPluginOrderChangedDetail>).detail;
      if (detail?.order) {
        setPluginOrder(detail.order);
      }
    };
    window.addEventListener(DSH_PLUGIN_ORDER_CHANGED_EVENT, handleOrderChanged);
    return () => {
      active = false;
      window.removeEventListener(DSH_PLUGIN_ORDER_CHANGED_EVENT, handleOrderChanged);
    };
  }, []);

  // Sync plugin list when changed externally (e.g. built-in CLI or DSH Web view).
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = dshHostService.onPluginsChanged(() => {
      if (updateTargetRef.current !== null) return;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (mountedRef.current && updateTargetRef.current === null) {
          void refresh();
        }
      }, 250);
    });
    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      unsubscribe();
    };
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

  const { userPlugins: rawUserPlugins, coreComponents } = useMemo(
    () => partitionPlugins(plugins),
    [plugins],
  );
  const userPlugins = useMemo(
    () => sortPluginsByDisplayOrder(rawUserPlugins, pluginOrder),
    [rawUserPlugins, pluginOrder],
  );
  const sidebarPlacementByName = useMemo(
    () => resolveSidebarPluginPlacement(userPlugins),
    [userPlugins],
  );
  const sidebarPanelCount = Object.keys(sidebarPlacementByName).length;
  const hasSidebarOverflow = sidebarPanelCount > MAX_VISIBLE_SIDEBAR_PLUGIN_PANELS;
  const canReorderPlugins = userPlugins.length > 1;
  const isReorderDisabled =
    !canReorderPlugins || busyPlugin !== null || restarting || updateTarget !== null;
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handlePluginDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id || isReorderDisabled) return;
      const ids = userPlugins.map((plugin) => plugin.name);
      const oldIndex = ids.indexOf(String(active.id));
      const newIndex = ids.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
      const nextOrder = arrayMove(ids, oldIndex, newIndex);
      setPluginOrder(nextOrder);
      void saveDshPluginOrder(nextOrder);
    },
    [isReorderDisabled, userPlugins],
  );
  const updatablePlugins = useMemo(
    () => userPlugins.filter(isRegistryUpdatablePlugin),
    [userPlugins],
  );
  const batchUpdateSummary = useMemo(
    () => summarizeBatchUpdateCheck(userPlugins, versionChecks, (key) => i18nService.t(key)),
    [userPlugins, versionChecks],
  );

  const checkSinglePluginVersions = useCallback(async (packageName: string): Promise<void> => {
    if (!mountedRef.current) return;
    if (versionChecksRef.current[packageName]?.phase === 'checking') return;
    if (updateTargetRef.current?.name === packageName) return;

    setVersionChecks((prev) => ({
      ...prev,
      [packageName]: { phase: 'checking' },
    }));

    let list: DshPluginVersionList;
    let checkedAt = Date.now();
    try {
      const res = await dshHostService.checkPluginVersions({ name: packageName });
      if (res.ok && res.list) {
        list = res.list;
        checkedAt = res.checkedAt ?? Date.now();
      } else {
        list = {
          status: 'refused',
          problem: 'unknown',
          reason: res.error || i18nService.t('dshPluginsVersionsFailedOther'),
          attempts: [],
        };
      }
    } catch (error) {
      list = {
        status: 'refused',
        problem: 'unknown',
        reason: error instanceof Error ? error.message : String(error),
        attempts: [],
      };
    }

    if (!mountedRef.current) return;
    setVersionChecks((prev) => ({
      ...prev,
      [packageName]: { phase: 'done', checkedAt, list },
    }));
  }, []);

  const ensurePluginVersions = useCallback(
    (packageName: string) => {
      if (versionChecksRef.current[packageName] !== undefined) return;
      void checkSinglePluginVersions(packageName);
    },
    [checkSinglePluginVersions],
  );

  const handleCheckAllUpdates = async () => {
    if (checkingAllUpdates || restarting || updateTarget !== null) return;
    setCheckingAllUpdates(true);
    setErrorMessage(null);
    try {
      const latestPlugins = await refresh();
      const targets = latestPlugins.filter(isRegistryUpdatablePlugin);
      for (const plugin of targets) {
        if (!mountedRef.current) break;
        await checkSinglePluginVersions(plugin.name);
      }
    } finally {
      if (mountedRef.current) {
        setCheckingAllUpdates(false);
      }
    }
  };

  const handleToggleVersionsDrawer = (pluginName: string) => {
    const nextOpen = !expandedVersions[pluginName];
    setExpandedVersions((prev) => ({ ...prev, [pluginName]: nextOpen }));
    if (nextOpen) {
      ensurePluginVersions(pluginName);
    }
  };

  const handleOpenUpdateModal = (
    plugin: DshPluginEntry,
    version: string,
    registry?: string | null,
  ) => {
    if (busyPlugin || restarting || updateTarget !== null) return;
    setUpdateTarget({
      name: plugin.name,
      title: resolvePluginDisplayTitle(plugin, language, t),
      fromVersion: plugin.version ?? '',
      toVersion: version,
      ...(registry !== undefined ? { registry } : {}),
    });
  };

  const handleUpdateSettled = (outcome: DshPluginUpdateOutcome) => {
    const updatedName = updateTargetRef.current?.name;
    if (outcome.plugins) {
      setPlugins(outcome.plugins);
      setVersionChecks((prev) => dropStaleVersionChecks(outcome.plugins!, prev));
    }
    if (outcome.restartRequired) {
      setRestartRequired(true);
    }
    void refresh().then(() => {
      if (outcome.ok && updatedName && mountedRef.current) {
        void checkSinglePluginVersions(updatedName);
      }
    });
  };

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

  useEffect(() => {
    if (!highlightedPlugin) return undefined;
    const timer = setTimeout(() => {
      setHighlightedPlugin(null);
    }, 3500);
    return () => clearTimeout(timer);
  }, [highlightedPlugin]);

  const handleInstalled = (res: DshPluginMutationResult) => {
    setErrorMessage(null);
    applyMutationFeedback(res, 'dshPluginsInstalledHot');
    if (res.bundle) {
      setHighlightedPlugin(res.bundle);
    }
    void refresh();
  };

  const handleBackgroundInstallOutcome = useCallback(
    (outcome: BackgroundInstallOutcome) => {
      if (outcome === BackgroundInstallOutcome.Done) {
        setErrorMessage(null);
        setNoticeMessage(i18nService.t('dshPluginsInstallBackgroundDone'));
      } else if (outcome === BackgroundInstallOutcome.Failed) {
        setNoticeMessage(null);
        setErrorMessage(i18nService.t('dshPluginsInstallBackgroundFailed'));
      } else if (outcome === BackgroundInstallOutcome.Cancelled) {
        setNoticeMessage(i18nService.t('dshPluginsInstallCancelledNotice'));
      }
    },
    [],
  );

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
          {updatablePlugins.length > 0 && (
            <button
              type="button"
              onClick={() => void handleCheckAllUpdates()}
              disabled={!hostHealthy || restarting || checkingAllUpdates || updateTarget !== null}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowPathIcon
                className={`h-3.5 w-3.5 text-secondary ${checkingAllUpdates ? 'animate-spin' : ''}`}
              />
              {checkingAllUpdates
                ? t('dshPluginsCheckingUpdatesBtn')
                : t('dshPluginsCheckUpdatesBtn')}
            </button>
          )}

          <button
            type="button"
            onClick={() => setInstallModalOpen(true)}
            disabled={restarting || updateTarget !== null}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-action px-3 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {installTaskActive ? (
              <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <PlusIcon className="h-3.5 w-3.5 stroke-[2.2]" />
            )}
            {installTaskActive ? t('dshPluginsInstallViewTask') : t('dshPluginsInstallModalTitle')}
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

                <div className="my-1 h-px bg-border" role="separator" />

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setRuntimeModeModalOpen(true);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-surface-raised"
                >
                  <CpuChipIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
                  <span className="min-w-0 flex-1 truncate">{t('dshAdvancedRuntimeModeTitle')}</span>
                  {runtimeModeEnabled && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                      aria-hidden="true"
                    />
                  )}
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
        <div className="space-y-1 px-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-secondary">
              {t('dshPluginsInstalledHeading')}
              {userPlugins.length > 0 ? ` (${userPlugins.length})` : ''}
            </h4>
            {batchUpdateSummary && (
              <span
                className={`text-xs ${
                  batchUpdateSummary.tone === BatchUpdateCheckSummaryTone.Info
                    ? 'font-medium text-foreground'
                    : batchUpdateSummary.tone === BatchUpdateCheckSummaryTone.Error
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-secondary'
                }`}
              >
                {batchUpdateSummary.text}
              </span>
            )}
          </div>
          {canReorderPlugins && (
            <p className="text-xs text-secondary">
              {t('dshPluginsReorderHint').replace(/\{count\}/g, String(MAX_VISIBLE_SIDEBAR_PLUGIN_PANELS))}
            </p>
          )}
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
              {t('dshPluginsInstallModalTitle')}
            </button>
          </div>
        ) : (
          <DndContext
            sensors={dragSensors}
            collisionDetection={closestCenter}
            onDragEnd={handlePluginDragEnd}
          >
            <SortableContext
              items={userPlugins.map((plugin) => plugin.name)}
              strategy={verticalListSortingStrategy}
            >
              <div className="divide-y divide-border rounded-xl border border-border bg-surface">
                {userPlugins.map((plugin) => {
                  const isBusy = busyPlugin === plugin.name;
                  const title = resolvePluginDisplayTitle(plugin, language, t);
                  const description = resolvePluginDisplayDescription(plugin, language);
                  const versionLabel = formatPluginVersion(plugin.version);
                  const showPackageNameSub = title !== plugin.name;
                  const isHybrid = plugin.surface === DshPluginSurface.Hybrid;
                  const isWebOnly = plugin.surface === DshPluginSurface.WebOnly;
                  const sidebarPlacement = sidebarPlacementByName[plugin.name];
                  const isRegistryUpdatable = isRegistryUpdatablePlugin(plugin);
                  const versionCheck = versionChecks[plugin.name];
                  const recommendedVersion = getPluginRecommendedVersion(versionCheck);
                  const recommendedVersionLabel = formatPluginVersion(recommendedVersion);
                  const checkedRegistry = getPluginVersionCheckRegistry(versionCheck);
                  const versionsExpanded = Boolean(expandedVersions[plugin.name]);
                  const isCheckingThis = versionCheck?.phase === 'checking';
                  const hasBlockedNewer =
                    !recommendedVersion
                    && versionCheck?.phase === 'done'
                    && versionCheck.list.status === 'listed'
                    && versionCheck.list.versions.length > 0;
                  const hasIncompatibleStable =
                    hasBlockedNewer
                    && versionCheck.phase === 'done'
                    && versionCheck.list.status === 'listed'
                    && versionCheck.list.versions.some((v) => !v.prerelease && v.incompatible !== undefined);
                  const checkFailed =
                    versionCheck?.phase === 'done' && versionCheck.list.status === 'refused';

                  return (
                    <SortablePluginRow
                      key={plugin.name}
                      id={plugin.name}
                      showHandle={canReorderPlugins}
                      disabled={isReorderDisabled}
                      dragHandleLabel={t('dshPluginsDragHandleLabel').replace('{name}', title)}
                    >
                      {(dragHandle) => (
                        <div
                          className={
                            highlightedPlugin === plugin.name
                              ? 'rounded-lg bg-primary/5 ring-1 ring-primary/30 -m-1.5 p-1.5 transition-colors'
                              : undefined
                          }
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex min-w-0 flex-1 items-start gap-3">
                              {dragHandle}
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
                                  {recommendedVersion && recommendedVersionLabel && (
                                    <button
                                      type="button"
                                      disabled={!hostHealthy || busyPlugin !== null || restarting || updateTarget !== null}
                                      onClick={() =>
                                        handleOpenUpdateModal(plugin, recommendedVersion, checkedRegistry)
                                      }
                                      className="inline-flex items-center gap-1 rounded bg-action/15 px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground transition-colors hover:bg-action/25 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                      <span>→ {recommendedVersionLabel}</span>
                                    </button>
                                  )}
                                  {hasBlockedNewer && (
                                    <button
                                      type="button"
                                      onClick={() => handleToggleVersionsDrawer(plugin.name)}
                                      className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-400/25 dark:text-amber-300"
                                    >
                                      {hasIncompatibleStable
                                        ? t('dshPluginsBadgeIncompatibleUpdate')
                                        : t('dshPluginsBadgePrereleaseOnly')}
                                    </button>
                                  )}
                                  {checkFailed && (
                                    <button
                                      type="button"
                                      onClick={() => handleToggleVersionsDrawer(plugin.name)}
                                      className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-500/25 dark:text-red-300"
                                    >
                                      {t('dshPluginsBadgeCheckFailed')}
                                    </button>
                                  )}
                                  {hasSidebarOverflow && sidebarPlacement === SidebarPluginPlacement.Pinned && (
                                    <span
                                      title={t('dshPluginsSidebarPinnedTooltip')}
                                      className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                                    >
                                      {t('dshPluginsSidebarPinnedBadge')}
                                    </span>
                                  )}
                                  {hasSidebarOverflow && sidebarPlacement === SidebarPluginPlacement.Overflow && (
                                    <span
                                      title={t('dshPluginsSidebarOverflowTooltip')}
                                      className="rounded-full bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-secondary"
                                    >
                                      {t('dshPluginsSidebarOverflowBadge')}
                                    </span>
                                  )}
                                  {isHybrid && Boolean(plugin.panelId) && (
                                    <span
                                      title={t('dshPluginsHybridTooltip')}
                                      className="rounded-full bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-secondary"
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
                                  {isRegistryUpdatable && hostHealthy && (
                                    <button
                                      type="button"
                                      onClick={() => handleToggleVersionsDrawer(plugin.name)}
                                      aria-expanded={versionsExpanded}
                                      className="inline-flex items-center gap-1 text-xs text-secondary transition-colors hover:text-foreground"
                                    >
                                      {isCheckingThis ? (
                                        <ArrowPathIcon className="h-3 w-3 animate-spin" />
                                      ) : versionsExpanded ? (
                                        <ChevronDownIcon className="h-3 w-3" />
                                      ) : (
                                        <ChevronRightIcon className="h-3 w-3" />
                                      )}
                                      <span>{t('dshPluginsVersionsToggle')}</span>
                                    </button>
                                  )}
                                  {plugin.enabled && plugin.panelId && !plugin.isThemePlugin && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        dispatchOpenEmbeddedPlugin({
                                          name: plugin.name,
                                          panelId: plugin.panelId!,
                                          ...(plugin.panelKind ? { panelKind: plugin.panelKind } : {}),
                                          title,
                                          ...(plugin.icon ? { icon: plugin.icon } : {}),
                                        });
                                      }}
                                      className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline underline-offset-2 transition-opacity hover:opacity-75"
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
                              {recommendedVersion && (
                                <button
                                  type="button"
                                  disabled={
                                    !hostHealthy || busyPlugin !== null || restarting || updateTarget !== null
                                  }
                                  onClick={() =>
                                    handleOpenUpdateModal(plugin, recommendedVersion, checkedRegistry)
                                  }
                                  className="inline-flex h-7 items-center gap-1 rounded-lg bg-action px-2.5 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                                  {t('dshPluginsUpdateBtn')}
                                </button>
                              )}
                              {isBusy && (
                                <ArrowPathIcon className="h-3.5 w-3.5 animate-spin text-secondary" />
                              )}
                              <SettingsSwitch
                                checked={plugin.enabled}
                                label={plugin.enabled ? t('dshEcosystemDisableLabel') : t('dshEcosystemEnableLabel')}
                                disabled={busyPlugin !== null || restarting || updateTarget !== null}
                                onClick={() => handleToggleEnabled(plugin, !plugin.enabled)}
                              />
                              {plugin.removable !== false && (
                                <button
                                  type="button"
                                  disabled={busyPlugin !== null || restarting || updateTarget !== null}
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

                          {isRegistryUpdatable && versionsExpanded && (
                            <div className={canReorderPlugins ? 'pl-[76px]' : 'pl-12'}>
                              <DshPluginVersionDrawer
                                installedVersion={plugin.version}
                                check={versionCheck}
                                disabled={!hostHealthy || busyPlugin !== null || restarting || updateTarget !== null}
                                onRecheck={() => void checkSinglePluginVersions(plugin.name)}
                                onSelectUpdate={(version, registry) =>
                                  handleOpenUpdateModal(plugin, version, registry)
                                }
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </SortablePluginRow>
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>
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

      {/* Advanced Runtime Modes Modal */}
      <DshAdvancedRuntimeModeModal
        isOpen={runtimeModeModalOpen}
        onClose={() => setRuntimeModeModalOpen(false)}
        hostHealthy={hostHealthy}
      />

      {/* Install Modal */}
      <DshPluginInstallModal
        isOpen={installModalOpen}
        onClose={() => setInstallModalOpen(false)}
        onInstalled={handleInstalled}
        onRestartHost={handleRestart}
        onActiveInstallChange={setInstallTaskActive}
        onBackgroundOutcome={handleBackgroundInstallOutcome}
      />

      {/* Update Modal */}
      <DshPluginUpdateModal
        target={updateTarget}
        onClose={() => setUpdateTarget(null)}
        onSettled={handleUpdateSettled}
        onRestartHost={handleRestart}
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
