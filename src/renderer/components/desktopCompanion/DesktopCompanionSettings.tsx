import { XMarkIcon } from '@heroicons/react/20/solid';
import { type ReactNode, useState } from 'react';

import {
  CompanionCapability,
  CompanionPermission,
  type DesktopCompanionPreferences,
} from '../../../shared/desktopCompanion/constants';
import { COMPANION_SKINS } from '../../../shared/desktopCompanion/skins';
import { i18nService } from '../../services/i18n';
import { CompanionMood } from './mascot/companionMood';
import LobsterHood from './mascot/LobsterHood';
import { companionShortcutFromKeys } from './shortcut';
import { useDesktopCompanionState } from './useDesktopCompanionState';

type ToggleKey = 'enabled' | 'selectionToolbar' | 'dragAssist' | 'contextHints';

// Same labeled card as the General tab's groups.
function SettingsGroup({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h4 className="px-1 text-xs font-semibold uppercase tracking-wider text-secondary">{title}</h4>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface">{children}</div>
      {footer}
    </section>
  );
}

export default function DesktopCompanionSettings() {
  const { state, error: loadError } = useDesktopCompanionState();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const t = (key: string) => i18nService.t(key);
  const api = window.electron.desktopCompanion;
  const preferences = state?.preferences;
  const enabled = preferences?.enabled ?? false;

  const update = async (patch: Partial<DesktopCompanionPreferences>) => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.setPreferences(patch);
      if (!result.success) setError(result.error ?? t('desktopCompanionRequestFailed'));
    } catch {
      setError(t('desktopCompanionRequestFailed'));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: ToggleKey, title: string, description: string, extra?: ReactNode, disabled = false) => {
    const checked = preferences?.[key] ?? false;
    return (
      <div className="px-4 py-3.5">
        <label className="flex items-center justify-between gap-4 text-sm font-medium text-foreground">
          {t(title)}
          <button
            type="button"
            role="switch"
            aria-label={t(title)}
            aria-checked={checked}
            className={'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ' + (checked ? 'bg-primary' : 'bg-secondary/30')}
            disabled={!state || saving || disabled}
            onClick={() => { void update({ [key]: !checked }); }}
          ><span className={'mt-0.5 inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ' + (checked ? 'translate-x-[18px]' : 'translate-x-0.5')} /></button>
        </label>
        <p className="mt-1 text-sm text-secondary">{t(description)}</p>
        {extra}
      </div>
    );
  };

  const selectionNote = (() => {
    if (!state || !preferences?.selectionToolbar || !enabled) return null;
    if (state.capabilities.selection === CompanionCapability.NeedsPermission) {
      return (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <span>{t('desktopCompanionSelectionNeedsPermission')}</span>
          <button type="button" className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-white" onClick={() => { void api.requestPermission(CompanionPermission.Accessibility); }}>
            {t('desktopCompanionGrantPermission')}
          </button>
        </div>
      );
    }
    if (state.capabilities.selection === CompanionCapability.Unsupported) {
      return <p className="mt-2 text-xs text-secondary">{t('desktopCompanionSelectionUnsupported')}</p>;
    }
    return null;
  })();

  const excluded = preferences?.selectionExcludedApps ?? [];

  return (
    <div className="space-y-8">
      <SettingsGroup
        title={t('desktopCompanionGroupDisplay')}
        footer={<p className="px-1 text-xs text-secondary">{t('desktopCompanionSettingsSaved')}</p>}
      >
        {toggle('enabled', 'desktopCompanionEnable', 'desktopCompanionEnableDescription')}
        <div className="px-4 py-3.5">
          <div className="text-sm font-medium text-foreground">{t('desktopCompanionSkin')}</div>
          <p className="mt-1 text-sm text-secondary">{t('desktopCompanionSkinDescription')}</p>
          <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-2" role="radiogroup" aria-label={t('desktopCompanionSkin')}>
            {COMPANION_SKINS.map(skin => {
              const selected = preferences?.skin === skin.id;
              return (
                <button
                  type="button"
                  key={skin.id}
                  role="radio"
                  aria-checked={selected}
                  disabled={!state || saving}
                  onClick={() => { void update({ skin: skin.id }); }}
                  className={'flex flex-col items-center gap-1.5 rounded-xl border px-1 pb-2 pt-2.5 text-xs transition-colors '
                    + (selected ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-secondary hover:bg-secondary/10')}
                >
                  <span className="grid h-11 w-11 place-items-center">
                    {skin.asset
                      ? <img src={skin.asset} alt="" className="h-11 w-11 object-contain" draggable={false} />
                      : <LobsterHood mood={CompanionMood.Idle} size={44} />}
                  </span>
                  <span className="max-w-full truncate">{t(skin.nameKey)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup title={t('desktopCompanionGroupFeatures')}>
        {toggle('selectionToolbar', 'desktopCompanionSelection', 'desktopCompanionSelectionDescription', (
          <>
            {selectionNote}
            {excluded.length > 0 && (
              <div className="mt-2.5">
                <div className="text-xs text-secondary">{t('desktopCompanionExcludedApps')}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {excluded.map(app => (
                    <span key={app} className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs text-foreground">
                      {app}
                      <button
                        type="button"
                        aria-label={`${t('desktopCompanionRemoveExcludedApp')} ${app}`}
                        className="text-secondary hover:text-foreground"
                        disabled={saving}
                        onClick={() => { void update({ selectionExcludedApps: excluded.filter(item => item !== app) }); }}
                      ><XMarkIcon className="h-3.5 w-3.5" /></button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {excluded.length === 0 && preferences?.selectionToolbar && <p className="mt-1.5 text-xs text-secondary">{t('desktopCompanionExcludedAppsEmpty')}</p>}
          </>
        ))}
        {toggle('dragAssist', 'desktopCompanionDragAssist', 'desktopCompanionDragAssistDescription', (
          state?.capabilities.globalDrag === CompanionCapability.Unsupported && preferences?.dragAssist
            ? <p className="mt-1.5 text-xs text-secondary">{t('desktopCompanionDragAssistLimited')}</p>
            : null
        ))}
        {toggle('contextHints', 'desktopCompanionHints', 'desktopCompanionHintsDescription')}
      </SettingsGroup>
      <SettingsGroup title={t('desktopCompanionGroupQuickPanel')}>
        <div className="space-y-2 px-4 py-3.5">
          <label htmlFor="desktop-companion-shortcut" className="text-sm font-medium text-foreground">{t('desktopCompanionShortcut')}</label>
          <div className="flex gap-2">
            <input
              id="desktop-companion-shortcut"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              readOnly
              disabled={!state || saving}
              value={preferences?.shortcut ?? ''}
              placeholder={t('desktopCompanionShortcutHint')}
              onKeyDown={event => {
                if (event.key === 'Escape') { event.currentTarget.blur(); return; }
                if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) return;
                event.preventDefault();
                const shortcut = companionShortcutFromKeys(event);
                if (shortcut) void update({ shortcut });
              }}
            />
            <button type="button" className="rounded-lg border border-border px-3 text-sm text-foreground" disabled={!state || saving || !preferences?.shortcut} onClick={() => { void update({ shortcut: '' }); }}>{t('clear')}</button>
          </div>
          {!preferences?.shortcut && <p className="text-xs text-secondary">{t('desktopCompanionShortcutDescription')}</p>}
          {state?.shortcutUnavailable && <p role="alert" className="text-sm text-red-500">{t('desktopCompanionShortcutUnavailable')}</p>}
        </div>
        <div className="px-4 py-3.5">
          <button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm text-white" disabled={!state} onClick={() => { void api.togglePanel().catch(() => setError(t('desktopCompanionRequestFailed'))); }}>{t('desktopCompanionOpenPanel')}</button>
        </div>
      </SettingsGroup>
      {(error || loadError) && <p role="alert" className="px-1 text-sm text-red-500">{error || t('desktopCompanionRequestFailed')}</p>}
    </div>
  );
}
