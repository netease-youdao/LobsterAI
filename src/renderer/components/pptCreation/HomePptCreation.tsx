import { ArrowRightIcon, ChevronUpIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { PptCreation, type PptExample } from '../../../shared/pptCreation/constants';
import { i18nService } from '../../services/i18n';
import { type PptDraftBackup, type PptDraftOptions, preparePptCreationDraft, restorePptCreationDraft } from '../../services/pptCreationDraft';
import type { RootState } from '../../store';
import Modal from '../common/Modal';
import { CoworkUiEvent } from '../cowork/constants';
import { reportPromptTemplateAction } from '../cowork/promptAnalytics';
import PptCoverWizard, { type PptCoverSeed, type PptCoverSession } from './PptCoverWizard';
import PptExampleDialog, { type PptExampleDialogState } from './PptExampleDialog';
import PptExampleGallery from './PptExampleGallery';
import { usePptCatalog } from './usePptCatalog';

export default function HomePptCreation({ active, onClose, onDraftReady, children }: {
  active: boolean; onClose: () => void; onDraftReady: (prompt: string) => void; children: ReactNode;
}) {
  const t = (key: string) => i18nService.t(key);
  const { catalog, failed, retry } = usePptCatalog();
  const owner = useSelector((state: RootState) => `${state.auth.ownerAccountKey}:${state.auth.accountGeneration}`);
  const [selected, setSelected] = useState<PptExample | null>(null);
  const [exampleState, setExampleState] = useState<PptExampleDialogState>();
  const [coverExample, setCoverExample] = useState<PptExample | null>(null);
  const [coverSession, setCoverSession] = useState<PptCoverSession>();
  const [coverSeed, setCoverSeed] = useState<PptCoverSeed>();
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<PptDraftBackup | null>(null);
  const preparation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const reset = () => { preparation.current++; setSelected(null); setExampleState(undefined); setCoverExample(null); setCoverSession(undefined); setCoverSeed(undefined); setShowAll(false); setBackup(null); setBusy(false); };
    const focus = (event: Event) => { if ((event as CustomEvent<{ clear?: boolean }>).detail?.clear) reset(); };
    window.addEventListener(CoworkUiEvent.ShortcutNewSession, reset);
    window.addEventListener(CoworkUiEvent.FocusInput, focus);
    return () => { mounted.current = false; window.removeEventListener(CoworkUiEvent.ShortcutNewSession, reset); window.removeEventListener(CoworkUiEvent.FocusInput, focus); };
  }, []);
  useEffect(() => { preparation.current++; setSelected(null); setExampleState(undefined); setCoverExample(null); setCoverSession(undefined); setCoverSeed(undefined); setShowAll(false); setBusy(false); }, [active, catalog?.version, catalog?.enabled, owner]);
  useEffect(() => { setBackup(null); }, [owner]);

  const applyExample = async (example: PptExample, options: PptDraftOptions): Promise<boolean> => {
    if (!catalog?.enabled) return false;
    const request = ++preparation.current;
    setBusy(true);
    try {
      const previous = await preparePptCreationDraft(catalog, example, options, () => mounted.current && preparation.current === request);
      if (!previous) return false;
      setBackup(previous); setExampleState(undefined); setCoverSession(undefined); setShowAll(false); onDraftReady(options.prompt);
      reportPromptTemplateAction({ templateActionType: 'template_prompt_click', templateId: PptCreation.ActionId, templateName: t('pptCreationHeading'),
        mappedSkillId: PptCreation.ActionId, promptId: example.id, promptName: example.title[i18nService.getLanguage()], promptLength: options.prompt.length,
        params: { exampleId: example.id, exampleMode: options.mode, exampleWorkflow: options.workflow, catalogVersion: catalog.version } });
      return true;
    } finally { if (mounted.current && preparation.current === request) setBusy(false); }
  };
  const openExample = (example: PptExample) => { setExampleState(undefined); setCoverSession(undefined); setCoverSeed(undefined); setSelected(example); };
  const gallery = (full = false) => catalog && <PptExampleGallery examples={catalog.examples} full={full} busy={busy} onSelect={openExample} />;
  return <>
    {backup && <div role="status" className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-primary-muted px-4 py-3 text-xs text-secondary">
      <span>{t('pptCreationReady')}</span><button type="button" className="shrink-0 font-medium text-primary hover:underline" onClick={() => { if (restorePptCreationDraft(backup)) onDraftReady(backup.prompt); setBackup(null); }}>{t('pptCreationRestore')}</button>
    </div>}
    {active && catalog?.enabled ? <section data-ppt-creation-home className="absolute inset-x-0 top-full animate-fade-in-up pb-6 pt-4 motion-reduce:animate-none" aria-labelledby="ppt-home-title">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1"><h2 id="ppt-home-title" className="text-sm font-semibold text-foreground">{t('pptCreationHeading')}</h2><p className="text-xs leading-5 text-foreground/65">{t('pptCreationGalleryHint')}</p></div>
        <button type="button" className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-foreground/70 transition-colors hover:bg-surface-raised hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setShowAll(true)}>{t('pptCreationMore')}<ArrowRightIcon aria-hidden="true" className="h-3.5 w-3.5" /></button>
      </div>
      {gallery()}
      {busy && <p role="status" className="mt-3 text-xs text-secondary">{t('pptCreationPreparing')}</p>}
      <div className="mt-1 flex justify-end text-xs leading-5 text-secondary">
        <button type="button" className="flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2 hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={onClose}>{t('coworkQuickActionCollapse')}<ChevronUpIcon aria-hidden="true" className="h-3.5 w-3.5" /></button>
      </div>
    </section> : active && !catalog && !failed ? null : <>
      {active && failed && <p className="mt-3 text-xs text-muted">{t('pptCreationLoadFailed')} <button type="button" className="text-primary" onClick={() => void retry()}>{t('retry')}</button></p>}
      {children}
    </>}
    {showAll && catalog?.enabled && <Modal onClose={() => setShowAll(false)} onEscape={() => setShowAll(false)}
      overlayClassName={selected || coverExample ? 'hidden' : undefined}
      className="non-draggable w-[min(1040px,94vw)] overflow-hidden rounded-3xl border border-border bg-surface shadow-modal">
      <div role="dialog" aria-modal="true" aria-labelledby="ppt-catalog-title" className="flex max-h-[90vh] flex-col">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-5"><div><h2 id="ppt-catalog-title" className="text-xl font-semibold text-foreground">{t('pptCreationHeading')}</h2><p className="mt-1 text-sm text-foreground/70">{t('pptCreationGalleryHint')}</p></div><button type="button" onClick={() => setShowAll(false)} aria-label={t('close')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><XMarkIcon aria-hidden="true" className="h-5 w-5" /></button></div>
        <div className="scrollbar-hidden min-h-0 overflow-y-auto overscroll-contain p-5 md:p-6">{gallery(true)}</div>
      </div>
    </Modal>}
    {selected && catalog?.enabled && <PptExampleDialog key={`${catalog.version}:${selected.id}:${coverSeed ? 'cover' : 'example'}`} catalog={catalog} example={selected}
      coverSeed={coverSeed} initialState={coverSeed ? undefined : exampleState}
      backLabel={coverSeed ? t('pptCoverBackToCover') : showAll ? t('pptCreationBackToAll') : undefined}
      onBack={coverSeed
        ? () => { setCoverExample(selected); setSelected(null); setCoverSeed(undefined); }
        : showAll
          ? () => { preparation.current++; setSelected(null); setExampleState(undefined); setCoverSession(undefined); setBusy(false); }
          : undefined}
      onCover={state => { setExampleState(state); setCoverExample(selected); setSelected(null); setCoverSeed(undefined); }}
      onClose={() => { preparation.current++; setSelected(null); setCoverSeed(undefined); setExampleState(undefined); setCoverSession(undefined); if (coverSeed) setShowAll(false); setBusy(false); }} onUse={applyExample} />}
    {coverExample && catalog?.enabled && <PptCoverWizard key={`${owner}:${catalog.version}:${coverExample.id}`} catalog={catalog} example={coverExample}
      initialSession={coverSession}
      onBack={session => { setCoverSession(session); setSelected(coverExample); setCoverExample(null); }}
      onClose={() => { setCoverExample(null); setCoverSession(undefined); setExampleState(undefined); setShowAll(false); }}
      onContinue={(seed, session) => { setCoverSession(session); setCoverSeed(seed); setSelected(coverExample); setCoverExample(null); }} />}
  </>;
}
