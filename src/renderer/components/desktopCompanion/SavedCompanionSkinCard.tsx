import { useRef, useState } from 'react';

import type { DesktopCompanionResult } from '../../../shared/desktopCompanion/constants';
import { CompanionCustomSkin, type CompanionCustomSkinAsset } from '../../../shared/desktopCompanion/customSkin';
import { i18nService } from '../../services/i18n';

interface Props {
  skin: CompanionCustomSkinAsset;
  label: string;
  selected: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => Promise<DesktopCompanionResult>;
  onDelete: (id: string) => Promise<DesktopCompanionResult>;
}

export default function SavedCompanionSkinCard({ skin, label, selected, disabled, onSelect, onRename, onDelete }: Props) {
  const t = (key: string) => i18nService.t(key);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(label);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'rename' | 'delete' | null>(null);
  const pending = useRef(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const close = () => { setEditing(false); setError(null); requestAnimationFrame(() => renameButton.current?.focus()); };
  const cancelDelete = () => { setConfirmDelete(false); setError(null); requestAnimationFrame(() => deleteButton.current?.focus()); };
  const save = async () => {
    if (disabled || pending.current || !name.trim()) return;
    pending.current = true; setSaving(true); setError(null);
    try {
      const result = await onRename(skin.id, name.trim());
      if (result.success) close(); else setError('rename');
    } catch { setError('rename'); }
    finally { pending.current = false; setSaving(false); }
  };
  const remove = async () => {
    if (disabled || pending.current || !confirmDelete) return;
    pending.current = true; setSaving(true); setError(null);
    try { if (!(await onDelete(skin.id)).success) setError('delete'); else setConfirmDelete(false); }
    catch { setError('delete'); }
    finally { pending.current = false; setSaving(false); }
  };
  return <div className={`min-w-0 rounded-xl border text-sm ${selected ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-secondary'}`}>
    <div className="flex items-center gap-1 pr-3">
      <button type="button" disabled={disabled || saving} aria-pressed={selected} title={label} onClick={() => onSelect(skin.id)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-secondary/10 disabled:opacity-50">
        <img src={skin.dataUrl} alt="" className="h-11 w-11 shrink-0 object-contain" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {selected && <span className="shrink-0 text-primary" aria-hidden="true">✓</span>}
      </button>
      <div className="flex shrink-0 flex-col py-1">
        <button ref={renameButton} type="button" disabled={disabled || saving} aria-label={`${t('rename')} ${label}`} aria-expanded={editing} className="rounded-md px-2 py-1.5 text-xs text-primary hover:bg-primary/10 disabled:opacity-50" onClick={() => { setConfirmDelete(false); setName(label); setError(null); setEditing(true); }}>{t('rename')}</button>
        <button ref={deleteButton} type="button" disabled={disabled || saving} aria-label={`${t('delete')} ${label}`} aria-expanded={confirmDelete} className="rounded-md px-2 py-1.5 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-50" onClick={() => { setEditing(false); setError(null); setConfirmDelete(true); }}>{t('delete')}</button>
      </div>
    </div>
    {confirmDelete && <div role="group" aria-label={t('desktopCompanionSkinDeleteConfirm')} className="space-y-3 border-t border-border px-3 py-3" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving) cancelDelete(); }
    }}>
      <p className="break-words text-sm text-foreground">{t('desktopCompanionSkinDeletePrompt').replace('{name}', label)}</p>
      {selected && <p className="text-xs text-secondary">{t('desktopCompanionSkinDeleteDefault')}</p>}
      <div className="flex flex-wrap gap-2">
        <button autoFocus type="button" disabled={saving} onClick={cancelDelete} className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-secondary/10 disabled:opacity-50">{t('cancel')}</button>
        <button type="button" disabled={saving || disabled} onClick={() => { void remove(); }} className="rounded-lg bg-red-500 px-3 py-1.5 text-xs text-white disabled:opacity-50">{saving ? t('desktopCompanionSkinDeleting') : t('desktopCompanionSkinDeleteConfirm')}</button>
      </div>
    </div>}
    {editing && <div className="space-y-2 border-t border-border px-3 py-3">
      <label className="block text-xs text-secondary">{t('desktopCompanionSkinEditName')}
        <input autoFocus value={name} maxLength={CompanionCustomSkin.MaxNameLength} disabled={saving || disabled} onFocus={event => event.target.select()} onChange={event => setName(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void save(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving) close(); }
        }} className="mt-2 w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30" />
      </label>
      <div className="flex gap-2">
        <button type="button" disabled={saving || disabled || !name.trim()} onClick={() => { void save(); }} className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white disabled:opacity-50">{saving ? t('desktopCompanionSkinSaving') : t('desktopCompanionSkinSaveName')}</button>
        <button type="button" disabled={saving} onClick={close} className="rounded-lg px-3 py-1.5 text-xs text-secondary hover:bg-secondary/10 disabled:opacity-50">{t('cancel')}</button>
      </div>
    </div>}
    {error && <p role="alert" className="px-3 pb-3 text-xs text-red-500">{error === 'delete' ? t('desktopCompanionSkinDeleteFailed') : t('desktopCompanionSkinRenameFailed')}</p>}
  </div>;
}
