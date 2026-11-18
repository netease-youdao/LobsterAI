import { ArrowPathIcon, ArrowRightIcon, CheckIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';

import type { PptCatalog, PptExample, PptPreparedFile } from '../../../shared/pptCreation/constants';
import { CoverIllustration, CoverStep, CoverTaskState, layoutCoverText, PptCover, type PptCoverFields } from '../../../shared/pptCreation/cover';
import { agentService } from '../../services/agent';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { coverImageModel, coverOwner, inspectCoverImage, readCoverImage, renderCoverPng, saveCoverFile, startCoverImage } from '../../services/pptCover';
import type { MediaModel } from '../../types/mediaGeneration';
import Modal from '../common/Modal';

export interface PptCoverSeed { file: PptPreparedFile; fields: PptCoverFields; previewBase64: string }
interface Draft {
  fields: PptCoverFields; subject: string; illustration: CoverIllustration;
  sessionId?: string; pending?: boolean; imagePath?: string; taskId?: string; imageModel?: string; imageSubject?: string;
}
const inputClass = 'scrollbar-hidden mt-2 min-h-11 w-full resize-none rounded-xl border border-border-input bg-background px-3 py-2.5 text-sm font-normal text-foreground placeholder:text-foreground/45 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-50';
const primaryButtonClass = 'flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50';
export default function PptCoverWizard({ catalog, example, onClose, onContinue }: {
  catalog: PptCatalog; example: PptExample; onClose: () => void; onContinue: (seed: PptCoverSeed) => void;
}) {
  const t = (key: string) => i18nService.t(key), language = i18nService.getLanguage();
  const recipe = example.cover!;
  const owner = coverOwner();
  const draftKey = `${PptCover.DraftKey}:${owner}:${catalog.version}:${example.id}`;
  const defaultDraft = (): Draft => ({
    fields: { title: recipe.title[language], subtitle: recipe.subtitle[language], footer: recipe.footer[language] },
    subject: recipe.subject[language], illustration: CoverIllustration.Reuse,
  });
  const [savedDraft, setSavedDraft] = useState<Draft | undefined>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || 'null') as Draft | null;
      if (saved && Object.values(CoverIllustration).includes(saved.illustration) && typeof saved.subject === 'string') {
        layoutCoverText(saved.fields); return saved;
      }
    } catch { /* An invalid draft cannot prevent opening a configured example. */ }
    return undefined;
  });
  const [draft, setDraft] = useState<Draft>(defaultDraft);
  const [editing, setEditing] = useState(false);
  const [restored, setRestored] = useState(false);
  const [step, setStep] = useState<number>(CoverStep.Content);
  const [background, setBackground] = useState('');
  const [generated, setGenerated] = useState('');
  const [rendered, setRendered] = useState<{ image: string; fields: PptCoverFields; base64: string }>();
  const [model, setModel] = useState<MediaModel>();
  const [modelError, setModelError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<{ file: PptPreparedFile; path: string; pngPath: string }>();
  const mounted = useRef(true), lock = useRef(false), close = useRef<HTMLButtonElement>(null);
  const current = () => mounted.current && owner === coverOwner();
  const image = draft.illustration === CoverIllustration.Generate ? generated : background;
  const preview = rendered?.image === image && rendered.fields === draft.fields ? rendered.base64 : '';
  const matchingImage = generated && draft.imageSubject === draft.subject;
  const isGenerating = Boolean(draft.pending && draft.sessionId);
  const disabled = busy || isGenerating;
  const dismiss = () => { if (!busy) onClose(); };

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null; close.current?.focus();
    window.electron.pptCreation.getCoverTemplate({ version: catalog.version, exampleId: example.id })
      .then(value => { if (mounted.current) setBackground(value.imageBase64); }).catch(() => { if (mounted.current) setError(t('pptCreationPrepareFailed')); });
    void coverImageModel(catalog).then(value => { if (mounted.current) setModel(value); })
      .catch(() => { if (mounted.current) setModelError(t('pptCoverModelUnavailable')); });
    return () => { mounted.current = false; previous?.focus(); };
    // The parent keys this component by catalog, example and authenticated owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Browsing an example must not overwrite a previously edited or paid-for cover.
    if (!editing) return;
    try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* Export and generation still work with storage disabled. */ }
  }, [draft, draftKey, editing]);
  useEffect(() => {
    if (!draft.imagePath) return;
    let disposed = false;
    void readCoverImage(draft.imagePath).then(value => { if (!disposed) setGenerated(value); })
      .catch(() => { if (!disposed) setError(t('pptCoverGenerationFailed')); });
    return () => { disposed = true; };

  }, [draft.imagePath]);
  useEffect(() => {
    if (!image) return;
    let disposed = false;
    const timer = window.setTimeout(() => {
      void renderCoverPng(image, draft.fields).then(value => { if (!disposed) { setRendered({ image, fields: draft.fields, base64: value }); setError(''); } })
        .catch(() => { if (!disposed) { setRendered(undefined); setError(t('pptCoverTextTooLong')); } });
    }, 120);
    return () => { disposed = true; clearTimeout(timer); };

  }, [image, draft.fields]);
  useEffect(() => {
    if (!draft.pending || !draft.sessionId) return;
    let disposed = false, checking = false;
    const check = async () => {
      if (checking || disposed) return;
      checking = true;
      try {
        const result = await inspectCoverImage(draft.sessionId!);
        if (disposed) return;
        if (result.state === CoverTaskState.Ready && result.path) {
          let bitmap: string;
          try { bitmap = await readCoverImage(result.path); }
          catch (failure) { if (!disposed) setDraft(value => ({ ...value, pending: false })); throw failure; }
          if (disposed) return;
          setGenerated(bitmap); setDraft(value => ({ ...value, pending: false, imagePath: result.path, taskId: result.taskId, imageModel: result.model, imageSubject: value.subject }));
          setStep(CoverStep.Preview); setError('');
        } else if (result.state === CoverTaskState.Failed) {
          setDraft(value => ({ ...value, pending: false })); setError(result.error || t('pptCoverGenerationFailed'));
        }
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : t('pptCoverGenerationFailed'));
      } finally { checking = false; }
    };
    void check(); const timer = window.setInterval(() => void check(), 3000);
    const timeout = window.setTimeout(() => { if (!disposed) setError(t('pptCoverTimeout')); }, 180_000);
    return () => { disposed = true; clearInterval(timer); clearTimeout(timeout); };

  }, [draft.pending, draft.sessionId]);

  const generate = async () => {
    if (lock.current || !background || !model || isGenerating) return;
    try { layoutCoverText(draft.fields); } catch { setError(t('pptCoverTextTooLong')); return; }
    lock.current = true; setBusy(true); setEditing(true); setError(''); setExported(undefined);
    try {
      const sessionId = await startCoverImage(catalog, example.id, draft.subject, background, current);
      if (current()) setDraft(value => ({ ...value, sessionId, pending: true }));
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : t('pptCoverGenerationFailed')); }
    finally { lock.current = false; if (current()) setBusy(false); }
  };
  const exportCover = async () => {
    if (lock.current || !preview || !image) return;
    lock.current = true; setBusy(true); setEditing(true); setError('');
    try {
      const file = await window.electron.pptCreation.exportCover({ version: catalog.version, exampleId: example.id, fields: draft.fields,
        ...(draft.illustration === CoverIllustration.Generate ? { imageBase64: generated } : {}) });
      const agent = await agentService.addPreset(catalog.expertPresetId);
      if (!agent || !current()) return;
      const path = await saveCoverFile(file, agent.workingDirectory || undefined);
      const pngPath = await saveCoverFile({ name: 'cover.png', mimeType: 'image/png', base64Data: preview }, agent.workingDirectory || undefined);
      if (current()) { setExported({ file, path, pngPath }); setStep(CoverStep.Export); }
    } catch { if (current()) setError(t('pptCoverExportFailed')); }
    finally { lock.current = false; if (current()) setBusy(false); }
  };
  const editDraft = (change: (value: Draft) => Draft) => { setEditing(true); setDraft(change); setExported(undefined); };
  const update = (fields: Partial<PptCoverFields>) => editDraft(value => ({ ...value, fields: { ...value.fields, ...fields } }));
  const restoreDraft = () => {
    if (!savedDraft || disabled) return;
    setDraft(savedDraft); setEditing(true); setRestored(true); setGenerated(''); setRendered(undefined);
    setStep(CoverStep.Content); setExported(undefined); setError('');
  };
  const startFromExample = () => {
    if (disabled) return;
    setSavedDraft(draft); setDraft(defaultDraft()); setEditing(false); setRestored(false); setGenerated(''); setRendered(undefined);
    setStep(CoverStep.Content); setExported(undefined); setError('');
  };
  const viewTask = async () => { if (draft.sessionId) { onClose(); await coworkService.loadSession(draft.sessionId); } };

  return <Modal onClose={dismiss} onEscape={dismiss} className="w-[min(1100px,95vw)] overflow-hidden rounded-3xl border border-border bg-surface shadow-modal">
    <div role="dialog" aria-modal="true" aria-labelledby="ppt-cover-title" data-ppt-cover-wizard className="flex h-[min(820px,92vh)] flex-col overflow-hidden"
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
      }}>
      <div className="shrink-0 border-b border-border px-5 py-5 md:px-7">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0"><p className="mb-1.5 text-xs font-medium text-foreground/60">{example.title[language]}</p><h2 id="ppt-cover-title" className="text-xl font-semibold text-foreground">{t('pptCoverHeading')}</h2></div>
          <button ref={close} type="button" onClick={dismiss} disabled={busy} aria-label={t('close')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40"><XMarkIcon aria-hidden="true" className="h-5 w-5" /></button>
        </div>
        <ol aria-label={t('pptCoverProgress')} className="mt-5 grid grid-cols-3 gap-2 text-xs">
          {['pptCoverContent', 'pptCoverPreview', 'pptCoverExport'].map((key, i) => <li key={key} aria-current={step === i ? 'step' : undefined} className={`flex min-w-0 items-center gap-2 ${step === i ? 'font-medium text-foreground' : 'text-foreground/60'}`}>
            <span aria-hidden="true" className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${step === i ? 'bg-primary text-primary-foreground' : step > i ? 'bg-primary-muted text-primary' : 'bg-surface-raised text-secondary'}`}>{step > i ? <CheckIcon className="h-4 w-4" /> : i + 1}</span>
            <span>{t(key)}</span>{i < 2 && <span aria-hidden="true" className={`ml-1 hidden h-px min-w-2 flex-1 sm:block ${step > i ? 'bg-primary/35' : 'bg-border'}`} />}
          </li>)}
        </ol>
      </div>
      <div className="scrollbar-hidden flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[1.15fr_1fr] md:overflow-hidden">
        <div className="scrollbar-hidden min-h-0 min-w-0 shrink-0 bg-surface-raised/60 p-5 md:overflow-y-auto md:overscroll-contain md:p-6">
          <p className="mb-3 text-xs font-medium text-foreground/70">{t('pptCoverLivePreview')}</p>
          <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
            {preview ? <img data-cover-preview src={`data:image/png;base64,${preview}`} alt={draft.fields.title} className="aspect-video w-full object-contain" />
              : <img src={example.previews[0].url} alt={example.title[language]} className="aspect-video w-full object-contain opacity-70" />}
          </div>
          <p className="mt-3 text-xs leading-5 text-foreground/65">{t('pptCoverPreviewHint')}</p>
          {!editing && savedDraft && <div className="mt-5 rounded-xl border border-border bg-surface p-4 text-xs leading-5 text-foreground/70">
            <p>{t(savedDraft.pending ? 'pptCoverSavedPending' : 'pptCoverSavedHint')}</p>
            <p className="mt-1 break-words font-medium text-foreground">{savedDraft.fields.title.replace(/\n/g, ' · ')}</p>
            <button type="button" disabled={busy} onClick={restoreDraft} className="mt-2 min-h-9 rounded-lg px-2 font-medium text-primary hover:bg-primary-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('pptCoverRestoreDraft')}</button>
          </div>}
          {editing && <div className="mt-4 text-xs leading-5">
            {restored && <p role="status" className="text-foreground/70">{t('pptCoverResume')}</p>}
            <button type="button" disabled={disabled} onClick={startFromExample} className="mt-1 min-h-9 rounded-lg px-2 text-primary hover:bg-primary-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">{t('pptCoverStartFromExample')}</button>
          </div>}
          {isGenerating && <div role="status" className="mt-5 rounded-xl border border-primary/15 bg-primary-muted p-4 text-sm text-foreground"><p className="flex items-center gap-2 font-medium"><ArrowPathIcon aria-hidden="true" className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" />{t('pptCoverGenerating')}</p><p className="mt-2 text-xs leading-5 text-foreground/75">{t('pptCoverTaskHint')}</p></div>}
          {draft.illustration === CoverIllustration.Generate && matchingImage && !isGenerating && <p className="mt-3 flex items-center gap-1.5 text-xs text-foreground/80"><CheckIcon aria-hidden="true" className="h-4 w-4 text-success" />{t('pptCoverImageReady')}</p>}
          {draft.sessionId && <button type="button" disabled={busy} onClick={() => void viewTask()} className="mt-4 min-h-9 rounded-lg px-2 text-xs text-primary hover:bg-primary-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('pptCoverViewTask')}</button>}
        </div>
        <div className="min-h-[25rem] min-w-0 shrink-0 border-t border-border p-5 md:min-h-0 md:overflow-hidden md:border-l md:border-t-0 md:p-6">
          <div data-ppt-cover-content className="scrollbar-hidden h-full min-h-0 space-y-5 overflow-y-auto overscroll-contain px-0.5 pb-1">
            {step !== CoverStep.Export ? <>
              <label className="block text-sm font-medium text-foreground">{t('pptCoverTitle')}<textarea aria-label={t('pptCoverTitle')} maxLength={50} rows={2} value={draft.fields.title} disabled={disabled} onChange={event => update({ title: event.target.value })} className={inputClass} /></label>
              <label className="block text-xs font-medium text-foreground/80">{t('pptCoverSubtitle')}<textarea aria-label={t('pptCoverSubtitle')} maxLength={90} rows={2} value={draft.fields.subtitle} disabled={disabled} onChange={event => update({ subtitle: event.target.value })} className={inputClass} /></label>
              <label className="block text-xs font-medium text-foreground/80">{t('pptCoverFooter')}<input aria-label={t('pptCoverFooter')} maxLength={50} value={draft.fields.footer} disabled={disabled} onChange={event => update({ footer: event.target.value })} className={inputClass} /></label>
              {step === CoverStep.Content && <>
                <div className="space-y-2" role="group" aria-label={t('pptCoverEntry')}>
                  <p className="mb-2 text-xs font-medium text-foreground/80">{t('pptCoverIllustration')}</p>
                  {[CoverIllustration.Reuse, CoverIllustration.Generate].map(value => <button type="button" key={value} disabled={disabled} aria-pressed={draft.illustration === value} onClick={() => { editDraft(previous => ({ ...previous, illustration: value })); setError(''); }}
                    className={`flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50 ${draft.illustration === value ? 'border-primary/50 bg-primary-muted' : 'border-border hover:border-foreground/20 hover:bg-surface-raised'}`}>
                    <span aria-hidden="true" className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${draft.illustration === value ? 'border-primary bg-primary text-primary-foreground' : 'border-foreground/30'}`}>{draft.illustration === value && <CheckIcon className="h-3 w-3" />}</span>
                    <span><span className="block text-sm font-medium text-foreground">{t(value === CoverIllustration.Reuse ? 'pptCoverReuse' : 'pptCoverGenerate')}</span><span className="mt-1 block text-xs leading-5 text-foreground/70">{t(value === CoverIllustration.Reuse ? 'pptCoverReuseHint' : 'pptCoverGenerateHint')}</span></span>
                  </button>)}
                </div>
                {draft.illustration === CoverIllustration.Generate && <>
                  <label className="block text-xs font-medium text-foreground/80">{t('pptCoverSubject')}<textarea aria-label={t('pptCoverSubject')} maxLength={800} rows={3} value={draft.subject} disabled={disabled} onChange={event => editDraft(value => ({ ...value, subject: event.target.value }))} placeholder={t('pptCoverSubjectHint')} className={inputClass} /></label>
                  <div className="rounded-xl border border-border bg-surface-raised p-3.5 text-xs leading-5 text-foreground/75"><p className="font-medium text-foreground">{t('pptCoverModel')}{model?.displayName || catalog.coverImageModel || PptCover.DefaultImageModel}</p>{model?.unitCredits !== undefined && <p className="mt-1">{t('pptCoverUnitCredits').replace('{credits}', String(model.unitCredits))}</p>}<p>{model?.pricingDescription || t('pptCoverPriceUnknown')}</p><p className="mt-2">{t('pptCoverCost')}</p></div>
                  {modelError && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">{modelError}</p>}
                </>}
              </>}
            </> : exported && <>
              <div role="status" data-cover-pptx={exported.path} data-cover-png={exported.pngPath} className="rounded-2xl border border-success/20 bg-success/5 p-5 text-sm leading-6 text-foreground"><span className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-success/10"><CheckIcon aria-hidden="true" className="h-5 w-5 text-success" /></span>{t('pptCoverExported')}</div>
              <div className="grid grid-cols-2 gap-3 text-xs font-medium text-foreground"><button type="button" onClick={() => void window.electron.shell.openPath(exported.path)} className="min-h-11 rounded-xl border border-border px-3 py-2 transition-colors hover:border-primary/40 hover:bg-primary-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('pptCoverOpenPpt')}</button><button type="button" onClick={() => void window.electron.shell.showItemInFolder(exported.path)} className="min-h-11 rounded-xl border border-border px-3 py-2 transition-colors hover:border-primary/40 hover:bg-primary-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('pptCoverOpenFolder')}</button></div>
              <p className="text-sm leading-6 text-foreground/70">{t('pptCoverContinueHint')}</p>
            </>}
          </div>
        </div>
      </div>
      <div data-ppt-cover-actions className="grid shrink-0 items-center gap-3 border-t border-border bg-surface px-5 py-4 md:grid-cols-[1.15fr_1fr] md:gap-12 md:px-6">
        <div className="space-y-1 text-xs leading-5">
          {step === CoverStep.Content && <p className="text-foreground/65">{t(draft.illustration === CoverIllustration.Reuse ? 'pptCoverReuseHint' : 'pptCoverCost')}</p>}
          {step !== CoverStep.Content && <button type="button" disabled={disabled} onClick={() => { setStep(CoverStep.Content); setExported(undefined); }} className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-foreground/80 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"><ArrowRightIcon aria-hidden="true" className="h-4 w-4 rotate-180" />{t('pptCoverBack')}</button>}
          {step === CoverStep.Preview && draft.illustration === CoverIllustration.Generate && <button type="button" disabled={disabled || !model} onClick={() => void generate()} className="min-h-9 rounded-lg px-2 text-primary hover:bg-primary-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">{t('pptCoverRegenerate')}</button>}
        </div>
        <div className="min-w-0 space-y-2">
          {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">{error}</p>}
          {!background && !error && <p role="status" className="text-xs text-foreground/65">{t('pptCoverChecking')}</p>}
          {step === CoverStep.Content && <button type="button" disabled={disabled || !background || !draft.fields.title.trim() || (draft.illustration === CoverIllustration.Generate && (!model || !draft.subject.trim()))} onClick={() => {
            if (draft.illustration === CoverIllustration.Generate && !matchingImage) void generate();
            else if (preview) { setStep(CoverStep.Preview); setError(''); }
          }} className={primaryButtonClass}>{t(draft.illustration === CoverIllustration.Generate && !matchingImage ? 'pptCoverGenerateButton' : 'pptCoverNext')}<ArrowRightIcon aria-hidden="true" className="h-4 w-4 shrink-0" /></button>}
          {step === CoverStep.Preview && <button type="button" disabled={disabled || !preview} onClick={() => void exportCover()} className={primaryButtonClass}>{t(busy ? 'pptCoverPreparing' : 'pptCoverExportButton')}<ArrowRightIcon aria-hidden="true" className="h-4 w-4 shrink-0" /></button>}
          {step === CoverStep.Export && exported && <button type="button" onClick={() => onContinue({ file: exported.file, fields: draft.fields, previewBase64: preview })} className={primaryButtonClass}>{t('pptCoverContinue')}<ArrowRightIcon aria-hidden="true" className="h-4 w-4 shrink-0" /></button>}
        </div>
      </div>
    </div>
  </Modal>;
}
