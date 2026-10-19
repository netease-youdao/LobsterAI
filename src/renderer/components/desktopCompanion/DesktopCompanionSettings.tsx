import { CheckIcon, ChevronRightIcon } from '@heroicons/react/20/solid';
import { AdjustmentsHorizontalIcon } from '@heroicons/react/24/outline';
import { type ReactNode, useState } from 'react';

import {
  CompanionCapability,
  CompanionPermission,
  type DesktopCompanionPreferences,
} from '../../../shared/desktopCompanion/constants';
import { COMPANION_SKINS, type CompanionSkin, CompanionSkinKind } from '../../../shared/desktopCompanion/skins';
import { i18nService } from '../../services/i18n';
import LobsterMark from './mascot/LobsterMark';
import SelectionToolbarSettings from './SelectionToolbarSettings';
import { useDesktopCompanionState } from './useDesktopCompanionState';

type ToggleKey = 'enabled' | 'selectionToolbar' | 'dragAssist' | 'contextHints';

function SkinPreview({ skin }: { skin: CompanionSkin }) {
  if (skin.kind === CompanionSkinKind.Brand || !skin.asset) return <LobsterMark size={32} />;
  return <img src={skin.asset} alt="" className="h-11 w-11 object-contain" draggable={false} />;
}

// Same labeled card as the General tab's groups.
function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h4 className="px-1 text-xs font-semibold uppercase tracking-wider text-secondary">{title}</h4>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface">{children}</div>
    </section>
  );
}

export default function DesktopCompanionSettings() {
  const { state, error: loadError } = useDesktopCompanionState();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selectionSettingsOpen, setSelectionSettingsOpen] = useState(false);
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

  return (
    <div className="space-y-8">
      <SettingsGroup title={t('desktopCompanionGroupDisplay')}>
        {toggle('enabled', 'desktopCompanionEnable', 'desktopCompanionEnableDescription')}
        <div className="px-4 py-3.5">
          <div className="text-sm font-medium text-foreground">{t('desktopCompanionSkin')}</div>
          <p className="mt-1 text-sm text-secondary">{t('desktopCompanionSkinDescription')}</p>
          <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('desktopCompanionSkin')}>
            {COMPANION_SKINS.map(skin => {
              const selected = preferences?.skin === skin.id;
              return (
                <button
                  type="button"
                  key={skin.id}
                  role="radio"
                  aria-checked={selected}
                  title={t(skin.nameKey)}
                  disabled={!state || saving}
                  onClick={() => { void update({ skin: skin.id }); }}
                  className={'relative flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-xs transition-colors disabled:opacity-50 '
                    + (selected ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-secondary hover:bg-secondary/10')}
                >
                  <span className="grid h-11 w-11 shrink-0 place-items-center">
                    <SkinPreview skin={skin} />
                  </span>
                  <span className="min-w-0 truncate font-medium">{t(skin.nameKey)}</span>
                  {selected && <CheckIcon className="absolute right-1.5 top-1.5 h-3.5 w-3.5 text-primary" aria-hidden="true" />}
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
            <button type="button" disabled={!state}
              onClick={() => setSelectionSettingsOpen(true)}
              className="mt-3 flex w-full items-center gap-3 rounded-lg bg-background px-3 py-2.5 text-left transition-colors hover:bg-secondary/10 disabled:opacity-50">
              <AdjustmentsHorizontalIcon className="h-5 w-5 shrink-0 text-secondary" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{t('desktopCompanionToolbarCustomize')}</span>
                <span className="mt-0.5 block text-xs text-secondary">{t('desktopCompanionToolbarCustomizeDescription')}</span>
              </span>
              <ChevronRightIcon className="h-4 w-4 shrink-0 text-secondary" />
            </button>
          </>
        ))}
        {toggle('dragAssist', 'desktopCompanionDragAssist', 'desktopCompanionDragAssistDescription', (
          state?.capabilities.globalDrag === CompanionCapability.Unsupported && preferences?.dragAssist
            ? <p className="mt-1.5 text-xs text-secondary">{t('desktopCompanionDragAssistLimited')}</p>
            : null
        ))}
        {toggle('contextHints', 'desktopCompanionHints', 'desktopCompanionHintsDescription')}
      </SettingsGroup>
      {(error || loadError) && <p role="alert" className="px-1 text-sm text-red-500">{error || t('desktopCompanionRequestFailed')}</p>}
      {selectionSettingsOpen && preferences && (
        <SelectionToolbarSettings preferences={preferences} saving={saving} error={error} onUpdate={update} onClose={() => setSelectionSettingsOpen(false)} />
      )}
    </div>
  );
}
