import { useEffect, useRef, useState } from 'react';

import { DEFAULT_COMPANION_SKIN, type DesktopCompanionResult } from '../../../shared/desktopCompanion/constants';
import { CompanionCustomSkin, type CompanionCustomSkinAsset } from '../../../shared/desktopCompanion/customSkin';
import { i18nService } from '../../services/i18n';
import { cropCompanionSkinImage, readCompanionSkinImage } from './customSkinImage';
import SavedCompanionSkinCard from './SavedCompanionSkinCard';

interface Props {
  assets?: CompanionCustomSkinAsset[];
  selectedSkin?: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onApply?: (dataUrl: string, name?: string) => Promise<DesktopCompanionResult>;
  onRename?: (id: string, name: string) => Promise<DesktopCompanionResult>;
  onDelete?: (id: string) => Promise<DesktopCompanionResult>;
}

export default function CustomCompanionSkinEditor({ assets = [], selectedSkin, disabled, onSelect, onApply, onRename, onDelete }: Props) {
  const t = (key: string) => i18nService.t(key);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [x, setX] = useState(0.5);
  const [y, setY] = useState(0.5);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const working = useRef(false);
  const busy = disabled || pending;
  const button = 'rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-secondary/10 disabled:opacity-50';

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!image) { setPreview(''); return; }
    try { setPreview(cropCompanionSkinImage(image, zoom, x, y)); setError(''); }
    catch { setPreview(''); setError('desktopCompanionSkinPreviewFailed'); }
  }, [image, zoom, x, y]);

  const apply = async () => {
    if (busy || working.current || !preview) return;
    working.current = true; setPending(true); setError('');
    try {
      const result = await (onApply ?? window.electron.desktopCompanion.applyCustomSkin)(preview, name);
      if (mounted.current) {
        if (!result.success) setError('desktopCompanionRequestFailed');
        else { setImage(null); setName(''); setOpen(false); }
      }
    } catch { if (mounted.current) setError('desktopCompanionRequestFailed'); }
    finally { working.current = false; if (mounted.current) setPending(false); }
  };

  return <div className="mt-4 space-y-3 border-t border-border pt-4 non-draggable">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={button} disabled={busy} aria-expanded={open} onClick={() => setOpen(!open)}>{t('desktopCompanionSkinCustomize')}</button>
      <button type="button" className={button} disabled={busy || selectedSkin === DEFAULT_COMPANION_SKIN} onClick={() => onSelect(DEFAULT_COMPANION_SKIN)}>{t('desktopCompanionSkinRestore')}</button>
    </div>
    {assets.length > 0 && <div className="grid grid-cols-2 gap-2 lg:grid-cols-3" role="group" aria-label={t('desktopCompanionSkinLibrary')}>
      {assets.map((skin, index) => <SavedCompanionSkinCard key={skin.id} skin={skin} label={skin.name || `${t('desktopCompanionCustomSkin')} ${index + 1}`} selected={selectedSkin === skin.id} disabled={busy} onSelect={onSelect} onRename={(id, nextName) => (onRename ?? window.electron.desktopCompanion.renameCustomSkin)(id, nextName)} onDelete={id => (onDelete ?? window.electron.desktopCompanion.deleteCustomSkin)(id)} />)}
    </div>}
    {open && <div className="space-y-4 rounded-xl border border-border bg-background p-4">
      <label className="block text-sm font-medium text-foreground">{t('desktopCompanionSkinNewName')}
        <input value={name} maxLength={CompanionCustomSkin.MaxNameLength} disabled={busy} placeholder={t('desktopCompanionSkinNamePlaceholder')} className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30" onChange={event => setName(event.target.value)} />
      </label>
      <p className="text-xs text-secondary">{t('desktopCompanionSkinConstraints')}</p>
      <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} className="hidden" aria-label={t('desktopCompanionSkinUpload')} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (!file || busy || working.current) return;
        working.current = true; setPending(true); setError('');
        void readCompanionSkinImage(file).then(next => {
          if (mounted.current) { setImage(next); setZoom(1); setX(0.5); setY(0.5); }
        }).catch(() => { if (mounted.current) setError('desktopCompanionSkinConstraints'); })
          .finally(() => { working.current = false; if (mounted.current) setPending(false); });
      }} />
      <button type="button" disabled={busy} className={button} onClick={() => upload.current?.click()}>{t('desktopCompanionSkinUpload')}</button>
      {preview && <>
        <div className="flex justify-center rounded-xl border border-border p-4" style={{ backgroundImage: 'conic-gradient(#80808020 25%, transparent 0 50%, #80808020 0 75%, transparent 0)', backgroundSize: '16px 16px' }}>
          <img src={preview} alt={t('desktopCompanionSkinPreview')} className="h-32 w-32 object-contain" draggable={false} />
        </div>
        {[
          { label: 'desktopCompanionSkinZoom', value: zoom, set: setZoom, min: 0.5, max: 3 },
          { label: 'desktopCompanionSkinHorizontal', value: x, set: setX, min: 0, max: 1 },
          { label: 'desktopCompanionSkinVertical', value: y, set: setY, min: 0, max: 1 },
        ].map(control => <label key={control.label} className="flex items-center gap-3 text-xs text-secondary">{t(control.label)}
          <input type="range" min={control.min} max={control.max} step={0.01} value={control.value} disabled={busy} onChange={event => control.set(Number(event.target.value))} className="min-w-0 flex-1" />
        </label>)}
        <button type="button" disabled={busy} onClick={() => { void apply(); }} className="rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50">{t(pending ? 'desktopCompanionSkinSaving' : 'desktopCompanionSkinApply')}</button>
      </>}
    </div>}
    {error && <p role="alert" className="text-xs text-red-500">{t(error)}</p>}
  </div>;
}
