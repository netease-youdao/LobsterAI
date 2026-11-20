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
import { QuickActionBar, QuickActionChip } from '../quick-actions';
import ImageExampleDialog from './ImageExampleDialog';
import ImageExampleShelf from './ImageExampleShelf';
import { useImageCreationCatalog } from './useImageCreationCatalog';

interface Props {
  actions: LocalizedQuickAction[];
  selectedActionId: string | null;
  onActionSelect: (id: string) => void;
  onDeselect: () => void;
  onDraftReady: (prompt: string) => void;
  children: React.ReactNode;
}

export default function HomeImageCreation({ actions, selectedActionId, onActionSelect, onDeselect, onDraftReady, children }: Props) {
  const t = (key: string) => i18nService.t(key);
  const { catalog, failed, retry } = useImageCreationCatalog();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<ImageCreationExample | null>(null);
  const [backup, setBackup] = useState<ImageCreationDraftBackup | null>(null);
  const mounted = useRef(true);
  const preparation = useRef(0);
  const owner = useSelector((state: RootState) => `${state.auth.ownerAccountKey}:${state.auth.accountGeneration}`);
  const visible = expanded && !selectedActionId;
  useEffect(() => {
    mounted.current = true;
    const reset = () => { preparation.current++; setExpanded(false); setSelected(null); setBackup(null); };
    const onFocusInput = (event: Event) => { if ((event as CustomEvent<{ clear?: boolean }>).detail?.clear) reset(); };
    window.addEventListener(CoworkUiEvent.ShortcutNewSession, reset);
    window.addEventListener(CoworkUiEvent.FocusInput, onFocusInput);
    return () => {
      mounted.current = false;
      window.removeEventListener(CoworkUiEvent.ShortcutNewSession, reset);
      window.removeEventListener(CoworkUiEvent.FocusInput, onFocusInput);
    };
  }, []);
  useEffect(() => { preparation.current++; setExpanded(false); setBackup(null); setSelected(null); }, [owner]);
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
    <QuickActionBar actions={actions} selectedActionId={selectedActionId} onActionSelect={id => { setExpanded(false); onActionSelect(id); }}>
      {(catalog?.enabled || (!catalog && !failed)) && (
        <QuickActionChip
          selected={visible}
          aria-expanded={visible}
          aria-controls="image-creation-gallery"
          data-image-creation-tab={ImageCreation.TabId}
          onClick={() => { if (selectedActionId) onDeselect(); setExpanded(!visible); }}
          icon={<PhotoIcon className="h-3.5 w-3.5" strokeWidth={2} />}
          label={t('imageCreationTab')}
          badge={(
            <span
              className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none transition-colors duration-200 ${
                visible
                  ? 'bg-primary/15 text-primary-hover'
                  : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
              }`}
            >
              {t('imageCreationNew')}
            </span>
          )}
        />
      )}
    </QuickActionBar>
    {backup && <div role="status" className="mx-auto mt-4 flex max-w-3xl items-center justify-between gap-3 rounded-xl bg-primary-muted px-4 py-3 text-xs text-secondary">
      <span>{t('imageCreationReady')}</span>
      <button type="button" className="shrink-0 font-medium text-primary hover:underline" onClick={() => {
        if (restoreImageCreationDraft(backup)) onDraftReady(backup.prompt);
        setBackup(null);
      }}>{t('imageCreationRestore')}</button>
    </div>}
    {/* The shelf hangs below the quick-action block instead of sitting in its
        flow (the block is the positioned ancestor), so the greeting and input
        keep their place whether or not examples are showing or still loading;
        the page scrolls to reveal what does not fit. */}
    {visible && catalog?.enabled && <section id="image-creation-gallery" className="absolute inset-x-0 top-full animate-fade-in-up pb-10 pt-6" aria-labelledby="image-creation-heading">
      <h2 id="image-creation-heading" className="sr-only">{t('imageCreationHeading')}</h2>
      <ImageExampleShelf catalog={catalog} onSelect={setSelected} />
      <div className="mt-5 flex items-center justify-between gap-4 px-0.5 text-xs leading-5 text-muted">
        <button type="button" className="flex items-center gap-1 rounded transition-colors hover:text-foreground"
          onClick={() => window.dispatchEvent(new CustomEvent(ExpertUiEvent.OpenPlaza, { detail: { presetId: catalog.expertPresetId } }))}>{t('imageCreationMore')}<ArrowRightIcon className="h-3.5 w-3.5" /></button>
        <button type="button" className="flex shrink-0 items-center gap-1 rounded transition-colors hover:text-foreground"
          onClick={() => setExpanded(false)}>{t('coworkQuickActionCollapse')}<ChevronUpIcon className="h-3.5 w-3.5" /></button>
      </div>
    </section>}
    {visible && !catalog && !failed && <div className="absolute inset-x-0 top-full grid grid-cols-4 gap-x-4 pt-6" aria-label={t('loading')}>{Array.from({ length: 4 }, (_, index) => <div key={index} className="aspect-[8/5] animate-pulse rounded-xl bg-surface-raised" />)}</div>}
    {failed && !catalog && <p className="mt-3 text-center text-xs text-muted">{t('imageCreationLoadFailed')} <button type="button" className="text-primary hover:underline" onClick={() => void retry()}>{t('retry')}</button></p>}
    {children}
    {selected && <ImageExampleDialog key={selected.id} example={selected} onClose={() => { preparation.current++; setSelected(null); }} onUse={useExample} />}
  </div>;
}
