import { ArrowRightIcon, ChevronUpIcon, PhotoIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { ExpertUiEvent } from '../../../shared/agent/presets';
import { ImageCreation, type ImageCreationExample, type ImageExampleReference } from '../../../shared/imageCreation/constants';
import { i18nService } from '../../services/i18n';
import { type ImageCreationDraftBackup, prepareImageCreationDraft, restoreImageCreationDraft } from '../../services/imageCreationDraft';
import type { RootState } from '../../store';
import type { LocalizedQuickAction } from '../../types/quickAction';
import { CoworkUiEvent } from '../cowork/constants';
import { QuickActionBar } from '../quick-actions';
import ImageExampleDialog from './ImageExampleDialog';
import ImageExampleGallery from './ImageExampleGallery';
import { useImageCreationCatalog } from './useImageCreationCatalog';

interface Props {
  actions: LocalizedQuickAction[];
  selectedActionId: string | null;
  onActionSelect: (id: string) => void;
  onDeselect: () => void;
  onDraftReady: (prompt: string) => void;
  onGalleryVisibilityChange: (visible: boolean) => void;
  children: React.ReactNode;
}

export default function HomeImageCreation({ actions, selectedActionId, onActionSelect, onDeselect, onDraftReady, onGalleryVisibilityChange, children }: Props) {
  const t = (key: string) => i18nService.t(key);
  const { catalog, failed, retry } = useImageCreationCatalog();
  const [expanded, setExpanded] = useState(!selectedActionId);
  const [selected, setSelected] = useState<ImageCreationExample | null>(null);
  const [backup, setBackup] = useState<ImageCreationDraftBackup | null>(null);
  const mounted = useRef(true);
  const preparation = useRef(0);
  const owner = useSelector((state: RootState) => `${state.auth.ownerAccountKey}:${state.auth.accountGeneration}`);
  const visible = expanded && !selectedActionId;
  const galleryVisible = visible && Boolean(catalog?.enabled);
  useEffect(() => { onGalleryVisibilityChange(galleryVisible); }, [galleryVisible, onGalleryVisibilityChange]);
  useEffect(() => {
    mounted.current = true;
    const reset = () => { preparation.current++; setExpanded(true); setSelected(null); setBackup(null); };
    const onFocusInput = (event: Event) => { if ((event as CustomEvent<{ clear?: boolean }>).detail?.clear) reset(); };
    window.addEventListener(CoworkUiEvent.ShortcutNewSession, reset);
    window.addEventListener(CoworkUiEvent.FocusInput, onFocusInput);
    return () => {
      mounted.current = false;
      window.removeEventListener(CoworkUiEvent.ShortcutNewSession, reset);
      window.removeEventListener(CoworkUiEvent.FocusInput, onFocusInput);
    };
  }, []);
  useEffect(() => { preparation.current++; setBackup(null); setSelected(null); }, [owner]);
  useEffect(() => {
    if (!catalog?.enabled) { preparation.current++; setSelected(null); }
    else if (selected && !catalog.examples.some(example => example.id === selected.id)) setSelected(null);
  }, [catalog, selected]);

  const useExample = async (prompt: string, reference?: ImageExampleReference): Promise<boolean> => {
    if (!catalog?.enabled) return false;
    const request = ++preparation.current;
    const previous = await prepareImageCreationDraft(catalog.expertPresetId, prompt, reference,
      () => mounted.current && preparation.current === request);
    if (!previous) return false;
    setBackup(previous); setExpanded(false); onDraftReady(prompt);
    return true;
  };

  return <div className="w-full" data-image-creation-home>
    <div className={`flex flex-wrap items-center gap-x-6 gap-y-3 ${galleryVisible ? 'justify-between' : 'justify-center'}`}>
    <QuickActionBar actions={actions} selectedActionId={selectedActionId} relaxed={galleryVisible} onActionSelect={id => { setExpanded(false); onActionSelect(id); }}>
      {(catalog?.enabled || (!catalog && !failed)) && <button type="button" aria-pressed={visible} aria-expanded={visible} aria-controls="image-creation-gallery"
        data-image-creation-tab={ImageCreation.TabId} onClick={() => { if (selectedActionId) onDeselect(); setExpanded(!visible); }}
        className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[length:var(--lobster-text-sidebarCompact)] leading-5 transition-colors ${visible ? 'border-transparent bg-surface-raised font-medium text-foreground' : 'border-border-subtle bg-surface text-secondary hover:border-primary/30 hover:text-foreground'}`}>
        <PhotoIcon className="h-3.5 w-3.5" /><span>{t('imageCreationTab')}</span><span className="rounded bg-amber-500/10 px-1 text-[10px] text-amber-600 dark:text-amber-400">{t('imageCreationNew')}</span>
      </button>}
    </QuickActionBar>
    {visible && catalog?.enabled && <button type="button" className="ml-auto flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-secondary hover:bg-surface-raised hover:text-foreground" onClick={() => window.dispatchEvent(new CustomEvent(ExpertUiEvent.OpenPlaza, { detail: { presetId: catalog.expertPresetId } }))}>{t('imageCreationMore')}<ArrowRightIcon className="h-3.5 w-3.5" /></button>}
    </div>
    {backup && <div role="status" className="mx-auto mt-4 flex max-w-3xl items-center justify-between gap-3 rounded-xl bg-primary-muted px-4 py-3 text-xs text-secondary">
      <span>{t('imageCreationReady')}</span>
      <button type="button" className="shrink-0 font-medium text-primary hover:underline" onClick={() => {
        if (restoreImageCreationDraft(backup)) onDraftReady(backup.prompt);
        setBackup(null);
      }}>{t('imageCreationRestore')}</button>
    </div>}
    {visible && catalog?.enabled && <section id="image-creation-gallery" className="mt-7 animate-fade-in-up" aria-labelledby="image-creation-heading">
      <h2 id="image-creation-heading" className="sr-only">{t('imageCreationHeading')}</h2>
      <ImageExampleGallery catalog={catalog} onSelect={setSelected} />
      <div className="mt-9 flex items-center justify-between gap-4 px-0.5 text-xs leading-5 text-muted">
        <span>{t('imageCreationSubheading')}</span>
        <button type="button" onClick={() => setExpanded(false)} aria-label={t('coworkQuickActionCollapse')} className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 hover:bg-surface-raised"><span>{t('coworkQuickActionCollapse')}</span><ChevronUpIcon className="h-4 w-4" /></button>
      </div>
    </section>}
    {visible && !catalog && !failed && <div className="mt-7 grid grid-cols-2 gap-x-6 gap-y-9 lg:grid-cols-4" aria-label={t('loading')}>{Array.from({ length: 8 }, (_, index) => <div key={index} className="aspect-[8/5] animate-pulse rounded-2xl bg-surface-raised" />)}</div>}
    {failed && !catalog && <p className="mt-3 text-center text-xs text-muted">{t('imageCreationLoadFailed')} <button type="button" className="text-primary hover:underline" onClick={() => void retry()}>{t('retry')}</button></p>}
    {!visible && children}
    {selected && <ImageExampleDialog key={selected.id} example={selected} onClose={() => { preparation.current++; setSelected(null); }} onUse={useExample} />}
  </div>;
}
