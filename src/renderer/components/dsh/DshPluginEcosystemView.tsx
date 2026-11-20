import React, { useCallback, useEffect, useState } from 'react';

import {
  dshHostService,
  type DshHostStatusSnapshot,
  type DshPluginEntry,
} from '@/services/dshHost';
import { i18nService } from '@/services/i18n';

export const DshPluginEcosystemView: React.FC = () => {
  const t = (key: string) => i18nService.t(key);
  const [status, setStatus] = useState<DshHostStatusSnapshot | null>(null);
  const [plugins, setPlugins] = useState<DshPluginEntry[]>([]);
  const [cliShimPath, setCliShimPath] = useState<string | null>(null);
  const [packageSpec, setPackageSpec] = useState('');
  const [installing, setInstalling] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
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
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInstall = async (event: React.FormEvent) => {
    event.preventDefault();
    const spec = packageSpec.trim();
    if (!spec || installing) return;
    setInstalling(true);
    setErrorMessage(null);
    try {
      const res = await dshHostService.installPlugin(spec);
      if (!res.ok) {
        setErrorMessage(res.error || res.stderr || 'Install failed');
      } else {
        setPackageSpec('');
        setPlugins(res.plugins ?? []);
      }
      await refresh();
    } finally {
      setInstalling(false);
    }
  };

  const handleRemove = async (name: string) => {
    setErrorMessage(null);
    const res = await dshHostService.removePlugin(name);
    if (!res.ok) {
      setErrorMessage(res.error || res.stderr || 'Remove failed');
    } else {
      setPlugins(res.plugins ?? []);
    }
    await refresh();
  };

  const handleOpenEcosystem = async () => {
    setErrorMessage(null);
    const res = await dshHostService.openEcosystemView();
    if (!res.ok && res.error) {
      setErrorMessage(res.error);
    }
  };

  const handleRestart = async () => {
    setErrorMessage(null);
    const res = await dshHostService.restart();
    if (!res.ok && res.error) {
      setErrorMessage(res.error);
    }
    await refresh();
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">{t('dshEcosystemTitle')}</h3>
          <p className="mt-1 text-xs opacity-75">{t('dshEcosystemDesc')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={handleOpenEcosystem}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            {t('dshEcosystemOpenWeb')}
          </button>
          <button
            type="button"
            onClick={handleRestart}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
          >
            {t('dshEcosystemRestartHost')}
          </button>
          <button
            type="button"
            onClick={() => void dshHostService.openProfileDir()}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
          >
            {t('dshEcosystemOpenProfile')}
          </button>
        </div>
      </div>

      {status && (
        <div className="flex flex-wrap items-center gap-4 rounded-lg border px-3 py-2 text-xs">
          <span>
            DSH {status.runtimeVersion ?? '0.2.2-rc.5'} · <strong>{status.phase}</strong>
          </span>
          {cliShimPath && (
            <span className="truncate opacity-75">
              {t('dshEcosystemCliLabel')}: <code className="rounded bg-black/5 px-1 dark:bg-white/10">{cliShimPath}</code>
            </span>
          )}
        </div>
      )}

      {errorMessage && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {errorMessage}
        </div>
      )}

      <form onSubmit={handleInstall} className="flex items-center gap-2">
        <input
          type="text"
          value={packageSpec}
          onChange={(e) => setPackageSpec(e.target.value)}
          placeholder={t('dshEcosystemInstallPlaceholder')}
          className="flex-1 rounded-lg border bg-transparent px-3 py-1.5 text-xs outline-none focus:border-blue-500"
        />
        <button
          type="submit"
          disabled={installing || !packageSpec.trim()}
          className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {installing ? t('dshEcosystemInstalling') : t('dshEcosystemInstallBtn')}
        </button>
      </form>

      <div className="space-y-2">
        <h4 className="text-xs font-medium opacity-75">{t('dshEcosystemInstalledTitle')}</h4>
        {plugins.length === 0 ? (
          <p className="text-xs opacity-60">{t('dshEcosystemEmpty')}</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {plugins.map((plugin) => (
              <div key={plugin.name} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono font-medium">{plugin.name}</span>
                    {plugin.managed && (
                      <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                        {t('dshEcosystemManagedBadge')}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px] opacity-60">{plugin.specifier}</div>
                </div>
                {!plugin.managed && (
                  <button
                    type="button"
                    onClick={() => void handleRemove(plugin.name)}
                    className="shrink-0 rounded border px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                  >
                    {t('dshEcosystemRemoveBtn')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
