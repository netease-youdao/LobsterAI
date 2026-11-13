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
import PptCoverWizard, { type PptCoverSeed } from './PptCoverWizard';
import PptExampleDialog from './PptExampleDialog';
import PptExampleGallery from './PptExampleGallery';
import { usePptCatalog } from './usePptCatalog';

export default function HomePptCreation({ active, onClose, onDraftReady, children }: {
  active: boolean; onClose: () => void; onDraftReady: (prompt: string) => void; children: ReactNode;
}) {
  const t = (key: string) => i18nService.t(key);
  const { catalog, failed, retry } = usePptCatalog();
  const owner = useSelector((state: RootState) => `${state.auth.ownerAccountKey}:${state.auth.accountGeneration}`);
  const [selected, setSelected] = useState<PptExample | null>(null);
  const [coverExample, setCoverExample] = useState<PptExample | null>(null);
  const [coverSeed, setCoverSeed] = useState<PptCoverSeed>();
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<PptDraftBackup | null>(null);
  const preparation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const reset = () => { preparation.current++; setSelected(null); setCoverExample(null); setCoverSeed(undefined); setShowAll(false); setBackup(null); setBusy(false); };
    const focus = (event: Event) => { if ((event as CustomEvent<{ clear?: boolean }>).detail?.clear) reset(); };
    window.addEventListener(CoworkUiEvent.ShortcutNewSession, reset);
    window.addEventListener(CoworkUiEvent.FocusInput, focus);
    return () => { mounted.current = false; window.removeEventListener(CoworkUiEvent.ShortcutNewSession, reset); window.removeEventListener(CoworkUiEvent.FocusInput, focus); };
  }, []);
  useEffect(() => { preparation.current++; setSelected(null); setCoverExample(null); setCoverSeed(undefined); setShowAll(false); setBusy(false); }, [active, catalog?.version, catalog?.enabled, owner]);
  useEffect(() => { setBackup(null); }, [owner]);

  const applyExample = async (example: PptExample, options: PptDraftOptions): Promise<boolean> => {
    if (!catalog?.enabled) return false;
    const request = ++preparation.current;
    setBusy(true);
    try {
      const previous = await preparePptCreationDraft(catalog, example, options, () => mounted.current && preparation.current === request);
      if (!previous) return false;
      setBackup(previous); setShowAll(false); onDraftReady(options.prompt);
      reportPromptTemplateAction({ templateActionType: 'template_prompt_click', templateId: PptCreation.ActionId, templateName: t('pptCreationHeading'),
        mappedSkillId: PptCreation.ActionId, promptId: example.id, promptName: example.title[i18nService.getLanguage()], promptLength: options.prompt.length,
        params: { exampleId: example.id, exampleMode: options.mode, exampleWorkflow: options.workflow, catalogVersion: catalog.version } });
      return true;
    } finally { if (mounted.current && preparation.current === request) setBusy(false); }
  };
  const gallery = (full = false) => catalog && <PptExampleGallery examples={catalog.examples} full={full} busy={busy} onSelect={setSelected} />;
  return <>
    {backup && <div role="status" className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-primary-muted px-4 py-3 text-xs text-secondary">
      <span>{t('pptCreationReady')}</span><button type="button" className="shrink-0 font-medium text-primary hover:underline" onClick={() => { if (restorePptCreationDraft(backup)) onDraftReady(backup.prompt); setBackup(null); }}>{t('pptCreationRestore')}</button>
    </div>}
    {active && catalog?.enabled ? <section data-ppt-creation-home className="absolute inset-x-0 top-full animate-fade-in-up pb-10 pt-6" aria-label={t('pptCreationHeading')}>
      {gallery()}
      {busy && <p role="status" className="mt-3 text-xs text-secondary">{t('pptCreationPreparing')}</p>}
      <div className="mt-5 flex items-center justify-between gap-4 px-0.5 text-xs leading-5 text-muted">
        <button type="button" className="flex items-center gap-1 hover:text-foreground" onClick={() => setShowAll(true)}>{t('pptCreationMore')}<ArrowRightIcon className="h-3.5 w-3.5" /></button>
        <button type="button" className="flex shrink-0 items-center gap-1 hover:text-foreground" onClick={onClose}>{t('coworkQuickActionCollapse')}<ChevronUpIcon className="h-3.5 w-3.5" /></button>
      </div>
    </section> : <>
      {active && failed && <p className="mt-3 text-xs text-muted">{t('pptCreationLoadFailed')} <button type="button" className="text-primary" onClick={() => void retry()}>{t('retry')}</button></p>}
      {children}
    </>}
    {showAll && catalog?.enabled && <Modal onClose={() => setShowAll(false)} onEscape={() => setShowAll(false)} className="w-[min(1040px,94vw)] rounded-2xl border border-border bg-surface p-6 shadow-float">
      <div role="dialog" aria-modal="true" aria-labelledby="ppt-catalog-title" className="scrollbar-hidden max-h-[85vh] overflow-auto">
        <div className="mb-5 flex items-center justify-between"><h2 id="ppt-catalog-title" className="text-xl font-semibold text-foreground">{t('pptCreationHeading')}</h2><button type="button" onClick={() => setShowAll(false)} aria-label={t('close')} className="rounded-lg p-1.5 text-secondary hover:bg-surface-raised"><XMarkIcon className="h-5 w-5" /></button></div>
        {gallery(true)}
      </div>
    </Modal>}
    {selected && catalog?.enabled && <PptExampleDialog key={`${catalog.version}:${selected.id}`} catalog={catalog} example={selected}
      coverSeed={coverSeed} onCover={() => { setCoverExample(selected); setSelected(null); setShowAll(false); setCoverSeed(undefined); }}
      onClose={() => { preparation.current++; setSelected(null); setCoverSeed(undefined); setBusy(false); }} onUse={applyExample} />}
    {coverExample && catalog?.enabled && <PptCoverWizard key={`${owner}:${catalog.version}:${coverExample.id}`} catalog={catalog} example={coverExample}
      onClose={() => setCoverExample(null)} onContinue={seed => { setCoverSeed(seed); setSelected(coverExample); setCoverExample(null); }} />}
  </>;
}
