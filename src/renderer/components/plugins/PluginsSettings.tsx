import { ArrowPathIcon, ArrowUpCircleIcon, Cog6ToothIcon,PlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useImperativeHandle, useRef,useState } from 'react';

import { i18nService } from '../../services/i18n';
import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import PluginConfigPage from './PluginConfigPage';

type PluginSource = 'npm' | 'clawhub' | 'git' | 'local' | 'openclaw';

interface PluginListItem {
  pluginId: string;
  version?: string;
  description?: string;
  source: PluginSource | 'bundled';
  enabled: boolean;
  canUninstall: boolean;
  hasConfig: boolean;
}

interface PluginUpdateInfo {
  pluginId: string;
  currentVersion: string | null;
  latestVersion: string | null;
  hasUpdate: boolean;
  error?: string;
}

interface InstallForm {
  source: PluginSource;
  spec: string;
  registry: string;
  version: string;
}

export interface PluginPendingChanges {
  toggles: Array<{ pluginId: string; enabled: boolean }>;
  configs: Array<{ pluginId: string; config: Record<string, unknown> }>;
}

export interface PluginsSettingsHandle {
  getPendingChanges: () => PluginPendingChanges | null;
  resetDirty: () => void;
  /** Returns true if leave is blocked (dialog shown). Caller should abort navigation. */
  guardLeave: (proceedAction: () => void) => boolean;
}

interface PluginsSettingsProps {
  handleRef?: React.Ref<PluginsSettingsHandle>;
}

const PLUGINS_ANALYTICS_SOURCE = 'settings_plugins';

const reportPluginAction = (
  actionType: string,
  result: 'success' | 'failed',
  options: {
    detectedCount?: number;
    hasRegistry?: boolean;
    hasVersion?: boolean;
    installSource?: string;
    updateCount?: number;
  } = {},
): void => {
  console.debug('[PluginsSettings] reporting plugin action analytics');
  void reportYdAnalyzer({
    action: LogReporterAction.PluginAction,
    source: PLUGINS_ANALYTICS_SOURCE,
    actionType,
    result,
    detectedCount: options.detectedCount,
    hasRegistry: options.hasRegistry,
    hasVersion: options.hasVersion,
    installSource: options.installSource,
    updateCount: options.updateCount,
  });
};

export default function PluginsSettings({ handleRef }: PluginsSettingsProps) {
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  const [loading, setLoading] = useState(true);
  // --- Unsaved-changes guard (internal dialog) ---
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const pendingLeaveActionRef = useRef<(() => void) | null>(null);
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<string>('');
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [configPluginId, setConfigPluginId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [detectedPlugins, setDetectedPlugins] = useState<string[] | null>(null);
  const [discoverResult, setDiscoverResult] = useState<string[] | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const [form, setForm] = useState<InstallForm>({
    source: 'npm',
    spec: '',
    registry: '',
    version: '',
  });

  // --- Update checking state ---
  const [checking, setChecking] = useState(false);
  const [updateInfos, setUpdateInfos] = useState<Map<string, PluginUpdateInfo>>(new Map());
  const [confirmUpdate, setConfirmUpdate] = useState<PluginUpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateLog, setUpdateLog] = useState<string>('');
  const updateLogRef = useRef<HTMLPreElement>(null);

  // --- Deferred save: track initial state and pending changes ---
  const initialPluginsRef = useRef<Map<string, boolean>>(new Map());
  const [pendingToggles, setPendingToggles] = useState<Map<string, boolean>>(new Map());
  const [pendingConfigs, setPendingConfigs] = useState<Map<string, Record<string, unknown>>>(new Map());
  // Store initial configs loaded from IPC for dirty comparison
  const initialConfigsRef = useRef<Map<string, Record<string, unknown>>>(new Map());

  // Compute dirty state
  const isDirty = useCallback((): boolean => {
    // Check toggles: compare current state against initial
    for (const [pluginId, enabled] of pendingToggles) {
      const initialEnabled = initialPluginsRef.current.get(pluginId);
      if (initialEnabled !== enabled) return true;
    }
    // Check configs
    for (const [pluginId, config] of pendingConfigs) {
      const initialConfig = initialConfigsRef.current.get(pluginId);
      if (JSON.stringify(config) !== JSON.stringify(initialConfig ?? {})) return true;
    }
    return false;
  }, [pendingToggles, pendingConfigs]);

  // Expose handle to parent
  useImperativeHandle(handleRef, () => ({
    getPendingChanges: (): PluginPendingChanges | null => {
      const dirty = isDirty();
      if (!dirty) return null;

      const toggles: PluginPendingChanges['toggles'] = [];
      for (const [pluginId, enabled] of pendingToggles) {
        const initialEnabled = initialPluginsRef.current.get(pluginId);
        if (initialEnabled !== enabled) {
          toggles.push({ pluginId, enabled });
        }
      }

      const configs: PluginPendingChanges['configs'] = [];
      for (const [pluginId, config] of pendingConfigs) {
        const initialConfig = initialConfigsRef.current.get(pluginId);
        if (JSON.stringify(config) !== JSON.stringify(initialConfig ?? {})) {
          configs.push({ pluginId, config });
        }
      }

      if (toggles.length === 0 && configs.length === 0) return null;
      return { toggles, configs };
    },
    resetDirty: () => {
      // Update initial refs to reflect current state after save
      for (const [pluginId, enabled] of pendingToggles) {
        initialPluginsRef.current.set(pluginId, enabled);
      }
      for (const [pluginId, config] of pendingConfigs) {
        initialConfigsRef.current.set(pluginId, config);
      }
      setPendingToggles(new Map());
      setPendingConfigs(new Map());
    },
    guardLeave: (proceedAction: () => void): boolean => {
      if (!isDirty()) return false;
      pendingLeaveActionRef.current = proceedAction;
      setShowUnsavedConfirm(true);
      return true;
    },
  }), [isDirty, pendingToggles, pendingConfigs]);

  const loadPlugins = useCallback(async () => {
    const result = await window.electron?.plugins.list();
    if (result?.success && result.plugins) {
      setPlugins(result.plugins);
      // Snapshot initial enabled state
      const initial = new Map<string, boolean>();
      for (const p of result.plugins) {
        initial.set(p.pluginId, p.enabled);
      }
      initialPluginsRef.current = initial;
    }
    setLoading(false);
  }, []);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await window.electron?.plugins.sync();
      if (result && result.synced.length > 0) {
        await loadPlugins();
      }
      reportPluginAction('sync', 'success', {
        detectedCount: result?.synced?.length ?? 0,
      });
    } finally {
      setSyncing(false);
      setDetectedPlugins(null);
    }
  }, [loadPlugins]);

  const handleDiscover = useCallback(async () => {
    setSyncing(true);
    setDiscoverResult(null);
    try {
      const detectResult = await window.electron?.plugins.detect();
      if (detectResult && detectResult.plugins.length > 0) {
        setDiscoverResult(detectResult.plugins);
        reportPluginAction('detect', 'success', {
          detectedCount: detectResult.plugins.length,
        });
      } else {
        setDiscoverResult([]);
        reportPluginAction('detect', 'success', {
          detectedCount: 0,
        });
      }
    } catch {
      setDiscoverResult([]);
      reportPluginAction('detect', 'failed');
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    // On mount: load plugins and detect any unsynced ones from OpenClaw
    const init = async () => {
      await loadPlugins();
      const detectResult = await window.electron?.plugins.detect();
      if (detectResult && detectResult.plugins.length > 0) {
        setDetectedPlugins(detectResult.plugins);
      }
    };
    init();
  }, [loadPlugins]);

  // Listen for install log events
  useEffect(() => {
    if (!installing) return;
    const cleanup = window.electron?.plugins.onInstallLog((line: string) => {
      setInstallLog(prev => prev + line);
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
      }
    });
    return cleanup;
  }, [installing]);

  // Listen for update log events (reuses the same install-log channel)
  useEffect(() => {
    if (!updating) return;
    const cleanup = window.electron?.plugins.onInstallLog((line: string) => {
      setUpdateLog(prev => prev + line);
      if (updateLogRef.current) {
        updateLogRef.current.scrollTop = updateLogRef.current.scrollHeight;
      }
    });
    return cleanup;
  }, [updating]);

  const handleToggle = (pluginId: string, enabled: boolean) => {
    // Only update local state — do NOT call IPC
    setPlugins(prev =>
      prev.map(p => p.pluginId === pluginId ? { ...p, enabled } : p),
    );
    setPendingToggles(prev => {
      const next = new Map(prev);
      next.set(pluginId, enabled);
      return next;
    });
  };

  const handleUninstall = async (pluginId: string) => {
    setUninstalling(true);
    const result = await window.electron?.plugins.uninstall(pluginId);
    setUninstalling(false);
    if (result?.ok) {
      setPlugins(prev => prev.filter(p => p.pluginId !== pluginId));
      // Remove from pending state and initial ref
      initialPluginsRef.current.delete(pluginId);
      setPendingToggles(prev => {
        const next = new Map(prev);
        next.delete(pluginId);
        return next;
      });
      setPendingConfigs(prev => {
        const next = new Map(prev);
        next.delete(pluginId);
        return next;
      });
      initialConfigsRef.current.delete(pluginId);
    }
    reportPluginAction('uninstall', result?.ok ? 'success' : 'failed');
    setConfirmUninstall(null);
  };

  const handleInstall = async () => {
    if (!form.spec.trim()) return;
    setInstalling(true);
    setInstallError(null);
    setInstallLog('');

    const params: {
      source: 'npm' | 'clawhub' | 'git' | 'local';
      spec: string;
      registry?: string;
      version?: string;
    } = {
      source: form.source as 'npm' | 'clawhub' | 'git' | 'local',
      spec: form.spec.trim(),
    };

    if (form.source === 'npm') {
      if (form.registry.trim()) params.registry = form.registry.trim();
      if (form.version.trim()) params.version = form.version.trim();
    } else if (form.source === 'git') {
      if (form.version.trim()) params.version = form.version.trim();
    }

    const result = await window.electron?.plugins.install(params);
    setInstalling(false);

    if (result?.ok) {
      setShowInstallModal(false);
      setForm({ source: 'npm', spec: '', registry: '', version: '' });
      loadPlugins();
      reportPluginAction('install', 'success', {
        hasRegistry: form.source === 'npm' ? form.registry.trim().length > 0 : undefined,
        hasVersion: form.version.trim().length > 0,
        installSource: form.source,
      });
    } else {
      setInstallError(result?.error || i18nService.t('pluginsInstallFailed'));
      reportPluginAction('install', 'failed', {
        hasRegistry: form.source === 'npm' ? form.registry.trim().length > 0 : undefined,
        hasVersion: form.version.trim().length > 0,
        installSource: form.source,
      });
    }
  };

  const handleConfigChange = useCallback((pluginId: string, config: Record<string, unknown>) => {
    setPendingConfigs(prev => {
      const next = new Map(prev);
      next.set(pluginId, config);
      return next;
    });
  }, []);

  const handleConfigLoaded = useCallback((pluginId: string, config: Record<string, unknown>) => {
    // Store initial config for dirty comparison (only if not already stored)
    if (!initialConfigsRef.current.has(pluginId)) {
      initialConfigsRef.current.set(pluginId, config);
    }
  }, []);

  const handleCheckUpdates = useCallback(async () => {
    setChecking(true);
    try {
      const result = await window.electron?.plugins.checkUpdates();
      if (result?.success && result.updates) {
        const map = new Map<string, PluginUpdateInfo>();
        for (const info of result.updates) {
          map.set(info.pluginId, info);
        }
        setUpdateInfos(map);
        reportPluginAction('check_updates', 'success', {
          updateCount: result.updates.filter(info => info.hasUpdate).length,
        });
      } else {
        reportPluginAction('check_updates', 'failed');
      }
    } catch {
      reportPluginAction('check_updates', 'failed');
    } finally {
      setChecking(false);
    }
  }, []);

  const handleUpdate = useCallback(async (pluginId: string) => {
    setUpdating(true);
    setUpdateLog('');
    const result = await window.electron?.plugins.update(pluginId);
    setUpdating(false);
    if (result?.ok) {
      setConfirmUpdate(null);
      setUpdateInfos(prev => {
        const next = new Map(prev);
        next.delete(pluginId);
        return next;
      });
      loadPlugins();
    }
    reportPluginAction('update', result?.ok ? 'success' : 'failed');
  }, [loadPlugins]);

  const sourceLabel = (source: PluginSource | 'bundled') => {
    switch (source) {
      case 'npm': return i18nService.t('pluginsSourceNpm');
      case 'clawhub': return i18nService.t('pluginsSourceClawhub');
      case 'git': return i18nService.t('pluginsSourceGit');
      case 'local': return i18nService.t('pluginsSourceLocal');
      case 'openclaw': return i18nService.t('pluginsSourceOpenclaw');
      case 'bundled': return 'Bundled';
    }
  };

  // Sub-view: Plugin config page
  if (configPluginId) {
    return (
      <PluginConfigPage
        pluginId={configPluginId}
        onBack={() => setConfigPluginId(null)}
        initialConfig={pendingConfigs.get(configPluginId)}
        onConfigChange={handleConfigChange}
        onConfigLoaded={handleConfigLoaded}
      />
    );
  }

  return (
    <div className="space-y-6 px-1">
      {/* Syncing overlay */}
      {syncing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border border-border rounded-xl shadow-lg p-6 flex items-center gap-3">
            <ArrowPathIcon className="h-5 w-5 animate-spin text-primary" />
            <span className="text-sm text-foreground">{i18nService.t('pluginsSyncing')}</span>
          </div>
        </div>
      )}

      {/* Detect confirmation dialog (auto-detect on page open) */}
      {detectedPlugins !== null && detectedPlugins.length > 0 && !syncing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border border-border rounded-xl shadow-lg w-full max-w-md p-6">
            <h3 className="text-base font-semibold text-foreground mb-2">
              {i18nService.t('pluginsSyncTitle')}
            </h3>
            <p className="text-sm text-muted-foreground mb-3">
              {i18nService.t('pluginsSyncFound').replace('{count}', String(detectedPlugins.length))}
            </p>
            <div className="mb-4 max-h-32 overflow-y-auto rounded-md border border-border bg-surface-raised p-2">
              {detectedPlugins.map(id => (
                <div key={id} className="text-xs text-foreground py-0.5 font-mono">{id}</div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mb-5">
              {i18nService.t('pluginsSyncLater')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDetectedPlugins(null)}
                className="px-4 py-2 text-sm rounded-md border border-border text-foreground hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('pluginsSyncSkip')}
              </button>
              <button
                type="button"
                onClick={runSync}
                className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                {i18nService.t('pluginsSyncNow')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">
            {i18nService.t('pluginsTitle')}
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            {i18nService.t('pluginsDesc')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCheckUpdates}
            disabled={checking}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-raised transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ArrowPathIcon className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
            {checking ? i18nService.t('pluginsChecking') : i18nService.t('pluginsCheckUpdates')}
          </button>
          <button
            type="button"
            onClick={() => { setShowInstallModal(true); setInstallLog(''); setInstallError(null); setDiscoverResult(null); }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <PlusIcon className="h-4 w-4" />
            {i18nService.t('pluginsInstall')}
          </button>
        </div>
      </div>

      {/* Plugin List */}
      {loading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading...</div>
      ) : plugins.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-sm text-muted-foreground">{i18nService.t('pluginsEmpty')}</p>
          <p className="text-xs text-muted-foreground mt-1">{i18nService.t('pluginsEmptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {plugins.map(plugin => (
            <div
              key={plugin.pluginId}
              className="flex items-center justify-between rounded-lg border border-border p-4"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      plugin.enabled ? 'bg-green-500' : 'bg-gray-400'
                    }`}
                  />
                  <span className="text-sm font-medium text-foreground truncate">
                    {plugin.pluginId}
                  </span>
                  {plugin.version && (
                    <span className="text-xs text-muted-foreground">v{plugin.version}</span>
                  )}
                  {updateInfos.get(plugin.pluginId)?.hasUpdate && (
                    <span className="text-xs text-primary font-medium">
                      → v{updateInfos.get(plugin.pluginId)!.latestVersion}
                    </span>
                  )}
                  <span className="text-xs px-1.5 py-0.5 rounded bg-surface-raised text-muted-foreground">
                    {sourceLabel(plugin.source)}
                  </span>
                </div>
                {plugin.description && (
                  <p className="text-xs text-muted-foreground mt-1 ml-4">
                    {plugin.description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 ml-4">
                {updateInfos.get(plugin.pluginId)?.hasUpdate && (
                  <button
                    type="button"
                    onClick={() => setConfirmUpdate(updateInfos.get(plugin.pluginId)!)}
                    className="p-1 rounded text-primary hover:text-primary hover:bg-primary/10 transition-colors"
                    title={i18nService.t('pluginsUpdate')}
                  >
                    <ArrowUpCircleIcon className="h-4 w-4" />
                  </button>
                )}
                {plugin.hasConfig && (
                  <button
                    type="button"
                    onClick={() => setConfigPluginId(plugin.pluginId)}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-surface-raised transition-colors"
                    title={i18nService.t('pluginsConfigTitle')}
                  >
                    <Cog6ToothIcon className="h-4 w-4" />
                  </button>
                )}
                {plugin.canUninstall && (
                  <button
                    type="button"
                    onClick={() => setConfirmUninstall(plugin.pluginId)}
                    className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    title={i18nService.t('pluginsUninstall')}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  role="switch"
                  aria-checked={plugin.enabled}
                  onClick={() => handleToggle(plugin.pluginId, !plugin.enabled)}
                  className={`
                    relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full
                    transition-colors duration-200 ease-in-out focus:outline-none
                    ${plugin.enabled ? 'bg-primary' : 'bg-border dark:bg-border'}
                  `}
                >
                  <span
                    className={`
                      inline-block h-4 w-4 rounded-full bg-white shadow-sm
                      transition-transform duration-200 ease-in-out
                      ${plugin.enabled ? 'translate-x-5' : 'translate-x-1'}
                    `}
                  />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Install Modal */}
      {showInstallModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border border-border rounded-xl shadow-lg w-full max-w-md p-6">
            <h3 className="text-base font-semibold text-foreground mb-4">
              {i18nService.t('pluginsInstallTitle')}
            </h3>

            {/* Source selector */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-foreground mb-1">
                {i18nService.t('pluginsSource')}
              </label>
              <div className="flex gap-1 flex-wrap">
                {(['npm', 'clawhub', 'git', 'local', 'openclaw'] as PluginSource[]).map(src => (
                  <button
                    key={src}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, source: src, spec: '' }))}
                    className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                      form.source === src
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-surface-raised text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {sourceLabel(src)}
                  </button>
                ))}
              </div>
            </div>

            {/* Dynamic fields based on source */}
            <div className="space-y-3">
              {form.source === 'npm' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      {i18nService.t('pluginsPackageName')}
                    </label>
                    <input
                      type="text"
                      value={form.spec}
                      onChange={e => setForm(f => ({ ...f, spec: e.target.value }))}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      placeholder="e.g. nsp-clawguard"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      {i18nService.t('pluginsVersion')}
                    </label>
                    <input
                      type="text"
                      value={form.version}
                      onChange={e => setForm(f => ({ ...f, version: e.target.value }))}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      placeholder={i18nService.t('pluginsVersionPlaceholder')}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      {i18nService.t('pluginsRegistry')}
                    </label>
                    <input
                      type="text"
                      value={form.registry}
                      onChange={e => setForm(f => ({ ...f, registry: e.target.value }))}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      placeholder={i18nService.t('pluginsRegistryPlaceholder')}
                    />
                  </div>
                </>
              )}

              {form.source === 'clawhub' && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    {i18nService.t('pluginsPackageName')}
                  </label>
                  <input
                    type="text"
                    value={form.spec}
                    onChange={e => setForm(f => ({ ...f, spec: e.target.value }))}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="e.g. openclaw-codex-app-server"
                  />
                </div>
              )}

              {form.source === 'git' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      {i18nService.t('pluginsGitUrl')}
                    </label>
                    <input
                      type="text"
                      value={form.spec}
                      onChange={e => setForm(f => ({ ...f, spec: e.target.value }))}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      placeholder={i18nService.t('pluginsGitUrlPlaceholder')}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      {i18nService.t('pluginsVersion')}
                    </label>
                    <input
                      type="text"
                      value={form.version}
                      onChange={e => setForm(f => ({ ...f, version: e.target.value }))}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      placeholder="tag / branch / commit"
                    />
                  </div>
                </>
              )}

              {form.source === 'local' && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    {i18nService.t('pluginsLocalPath')}
                  </label>
                  <input
                    type="text"
                    value={form.spec}
                    onChange={e => setForm(f => ({ ...f, spec: e.target.value }))}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="C:\\path\\to\\plugin or ./plugin.tgz"
                  />
                </div>
              )}

              {form.source === 'openclaw' && (
                <div className="text-center py-4">
                  <p className="text-sm text-muted-foreground mb-3">
                    {i18nService.t('pluginsSyncDesc')}
                  </p>
                  <button
                    type="button"
                    onClick={handleDiscover}
                    disabled={syncing}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ArrowPathIcon className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
                    {syncing ? i18nService.t('pluginsSyncing') : i18nService.t('pluginsSyncButton')}
                  </button>

                  {/* Inline discover results */}
                  {discoverResult !== null && !syncing && (
                    <div className="mt-4 text-left">
                      {discoverResult.length > 0 ? (
                        <>
                          <p className="text-sm text-foreground mb-2">
                            {i18nService.t('pluginsSyncFound').replace('{count}', String(discoverResult.length))}
                          </p>
                          <div className="mb-3 max-h-32 overflow-y-auto rounded-md border border-border bg-surface-raised p-2">
                            {discoverResult.map(id => (
                              <div key={id} className="text-xs text-foreground py-0.5 font-mono">{id}</div>
                            ))}
                          </div>
                          <div className="flex justify-center gap-2">
                            <button
                              type="button"
                              onClick={() => setDiscoverResult(null)}
                              className="px-3 py-1.5 text-xs rounded-md border border-border text-foreground hover:bg-surface-raised transition-colors"
                            >
                              {i18nService.t('pluginsSyncSkip')}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setShowInstallModal(false);
                                setDiscoverResult(null);
                                runSync();
                              }}
                              className="px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                            >
                              {i18nService.t('pluginsSyncNow')}
                            </button>
                          </div>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {i18nService.t('pluginsSyncNone')}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Install Log */}
            {form.source !== 'openclaw' && (installing || installLog) && (
              <pre
                ref={logRef}
                className="mt-3 text-xs font-mono bg-surface-raised border border-border rounded-md p-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-muted-foreground"
              >
                {installLog || 'Waiting...'}
              </pre>
            )}

            {/* Error */}
            {form.source !== 'openclaw' && installError && (
              <div className="mt-3 text-xs text-destructive bg-destructive/10 rounded-md p-2">
                {installError}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={() => { setShowInstallModal(false); setInstallError(null); setInstallLog(''); }}
                className="px-4 py-2 text-sm rounded-md border border-border text-foreground hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              {form.source !== 'openclaw' && (
                <button
                  type="button"
                  onClick={handleInstall}
                  disabled={installing || !form.spec.trim()}
                  className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {installing ? i18nService.t('pluginsInstalling') : i18nService.t('pluginsInstall')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Uninstall Confirmation Modal */}
      {confirmUninstall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border border-border rounded-xl shadow-lg w-full max-w-sm p-6">
            <h3 className="text-base font-semibold text-foreground mb-2">
              {i18nService.t('pluginsUninstallConfirm')}
            </h3>
            <p className="text-sm text-muted-foreground mb-5">
              {confirmUninstall}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmUninstall(null)}
                disabled={uninstalling}
                className="px-4 py-2 text-sm rounded-md border border-border text-foreground hover:bg-surface-raised transition-colors disabled:opacity-50"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => handleUninstall(confirmUninstall)}
                disabled={uninstalling}
                className="px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uninstalling ? i18nService.t('pluginsUninstalling') : i18nService.t('pluginsUninstall')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Update Confirmation Modal */}
      {confirmUpdate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border border-border rounded-xl shadow-lg w-full max-w-md p-6">
            <h3 className="text-base font-semibold text-foreground mb-2">
              {i18nService.t('pluginsUpdateConfirm')}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {confirmUpdate.pluginId}: v{confirmUpdate.currentVersion || '?'} → v{confirmUpdate.latestVersion}
            </p>
            {updateLog && (
              <pre
                ref={updateLogRef}
                className="text-xs font-mono bg-surface-raised border border-border rounded-md p-2 max-h-40 overflow-y-auto mb-4 whitespace-pre-wrap"
              >
                {updateLog}
              </pre>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setConfirmUpdate(null); setUpdateLog(''); }}
                disabled={updating}
                className="px-4 py-2 text-sm rounded-md border border-border text-foreground hover:bg-surface-raised transition-colors disabled:opacity-50"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => handleUpdate(confirmUpdate.pluginId)}
                disabled={updating}
                className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {updating ? i18nService.t('pluginsUpdating') : i18nService.t('pluginsUpdate')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unsaved changes confirmation dialog */}
      {showUnsavedConfirm && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-background border border-border shadow-modal p-5">
            <h4 className="text-sm font-semibold text-foreground mb-2">
              {i18nService.t('pluginsUnsavedTitle')}
            </h4>
            <p className="text-sm text-secondary mb-4">
              {i18nService.t('pluginsUnsavedMessage')}
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowUnsavedConfirm(false);
                  pendingLeaveActionRef.current = null;
                }}
                className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('pluginsUnsavedStay')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowUnsavedConfirm(false);
                  // Reset dirty state so subsequent navigation is not blocked
                  setPendingToggles(new Map());
                  setPendingConfigs(new Map());
                  const action = pendingLeaveActionRef.current;
                  pendingLeaveActionRef.current = null;
                  action?.();
                }}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity"
              >
                {i18nService.t('pluginsUnsavedDiscard')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
