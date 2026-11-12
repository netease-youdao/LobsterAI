import { ArrowPathIcon, ArrowRightIcon, CheckIcon,XMarkIcon } from '@heroicons/react/24/outline';
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
const inputClass = 'mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none disabled:opacity-50';
export default function PptCoverWizard({ catalog, example, onClose, onContinue }: {
  catalog: PptCatalog; example: PptExample; onClose: () => void; onContinue: (seed: PptCoverSeed) => void;
}) {
  const t = (key: string) => i18nService.t(key), language = i18nService.getLanguage();
  const recipe = example.cover!;
  const owner = coverOwner();
  const draftKey = `${PptCover.DraftKey}:${owner}:${catalog.version}:${example.id}`;
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || 'null') as Draft | null;
      if (saved && Object.values(CoverIllustration).includes(saved.illustration) && typeof saved.subject === 'string') {
        layoutCoverText(saved.fields); return saved;
      }
    } catch { /* An invalid draft cannot prevent opening a configured example. */ }
    return { fields: { title: recipe.title[language], subtitle: recipe.subtitle[language], footer: recipe.footer[language] },
      subject: recipe.subject[language], illustration: CoverIllustration.Reuse };
  });
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
  useEffect(() => { try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* Export and generation still work with storage disabled. */ } }, [draft, draftKey]);
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
    lock.current = true; setBusy(true); setError(''); setExported(undefined);
    try {
      const sessionId = await startCoverImage(catalog, example.id, draft.subject, background, current);
      if (current()) setDraft(value => ({ ...value, sessionId, pending: true }));
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : t('pptCoverGenerationFailed')); }
    finally { lock.current = false; if (current()) setBusy(false); }
  };
  const exportCover = async () => {
    if (lock.current || !preview || !image) return;
    lock.current = true; setBusy(true); setError('');
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
  const update = (fields: Partial<PptCoverFields>) => { setDraft(value => ({ ...value, fields: { ...value.fields, ...fields } })); setExported(undefined); };
  const viewTask = async () => { if (draft.sessionId) { onClose(); await coworkService.loadSession(draft.sessionId); } };

  return <Modal onClose={dismiss} onEscape={dismiss} className="w-[min(1100px,95vw)] rounded-2xl border border-border bg-surface shadow-float">
    <div role="dialog" aria-modal="true" aria-labelledby="ppt-cover-title" data-ppt-cover-wizard className="relative max-h-[90vh] overflow-y-auto rounded-2xl p-6 md:p-8"
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
      }}>
      <button ref={close} type="button" onClick={dismiss} disabled={busy} aria-label={t('close')} className="absolute right-4 top-4 rounded-lg p-1.5 text-secondary hover:bg-surface-raised"><XMarkIcon className="h-5 w-5" /></button>
      <p className="mb-2 text-xs text-primary">{example.title[language]}</p><h2 id="ppt-cover-title" className="text-xl font-semibold text-foreground">{t('pptCoverHeading')}</h2>
      <ol className="my-5 flex gap-5 text-xs">{['pptCoverContent', 'pptCoverPreview', 'pptCoverExport'].map((key, i) => <li key={key} aria-current={step === i ? 'step' : undefined} className={`flex items-center gap-2 ${step >= i ? 'text-primary' : 'text-muted'}`}><span className={`flex h-6 w-6 items-center justify-center rounded-full ${step >= i ? 'bg-primary-muted' : 'bg-background'}`}>{i + 1}</span>{t(key)}</li>)}</ol>
      <div className="grid gap-6 md:grid-cols-[1.25fr_1fr]">
        <div>
          <div className="overflow-hidden rounded-xl border border-border-subtle bg-[#F5F2EC] shadow-sm">
            {preview ? <img data-cover-preview src={`data:image/png;base64,${preview}`} alt={draft.fields.title} className="aspect-video w-full object-contain" />
              : <img src={example.previews[0].url} alt={example.title[language]} className="aspect-video w-full object-contain opacity-70" />}
          </div>
          <p className="mt-3 text-xs leading-5 text-muted">{t('pptCoverPreviewHint')}</p>
          {isGenerating && <div role="status" className="mt-5 rounded-xl bg-primary-muted p-4 text-sm text-primary"><p className="flex items-center gap-2"><ArrowPathIcon className="h-4 w-4 animate-spin" />{t('pptCoverGenerating')}</p><p className="mt-2 text-xs leading-5">{t('pptCoverTaskHint')}</p></div>}
          {draft.illustration === CoverIllustration.Generate && matchingImage && !isGenerating && <p className="mt-3 flex items-center gap-1.5 text-xs text-primary"><CheckIcon className="h-4 w-4" />{t('pptCoverImageReady')}</p>}
          {draft.sessionId && <button type="button" disabled={busy} onClick={() => void viewTask()} className="mt-4 text-xs text-primary hover:underline">{t('pptCoverViewTask')}</button>}
        </div>
        <div className="space-y-4">
          {step !== CoverStep.Export ? <>
            <label className="block text-xs font-medium text-secondary">{t('pptCoverTitle')}<textarea aria-label={t('pptCoverTitle')} maxLength={50} rows={2} value={draft.fields.title} disabled={disabled} onChange={event => update({ title: event.target.value })} className={inputClass} /></label>
            <label className="block text-xs text-secondary">{t('pptCoverSubtitle')}<textarea aria-label={t('pptCoverSubtitle')} maxLength={90} rows={2} value={draft.fields.subtitle} disabled={disabled} onChange={event => update({ subtitle: event.target.value })} className={inputClass} /></label>
            <label className="block text-xs text-secondary">{t('pptCoverFooter')}<input aria-label={t('pptCoverFooter')} maxLength={50} value={draft.fields.footer} disabled={disabled} onChange={event => update({ footer: event.target.value })} className={inputClass} /></label>
            {step === CoverStep.Content && <>
              <div className="space-y-2" role="group" aria-label={t('pptCoverEntry')}>{[CoverIllustration.Reuse, CoverIllustration.Generate].map(value => <button type="button" key={value} disabled={disabled} aria-pressed={draft.illustration === value} onClick={() => { setDraft(previous => ({ ...previous, illustration: value })); setExported(undefined); setError(''); }}
                className={`block w-full rounded-xl border px-4 py-3 text-left ${draft.illustration === value ? 'border-primary bg-primary-muted' : 'border-border'}`}><span className="text-sm font-medium text-foreground">{t(value === CoverIllustration.Reuse ? 'pptCoverReuse' : 'pptCoverGenerate')}</span><span className="mt-1 block text-xs leading-5 text-secondary">{t(value === CoverIllustration.Reuse ? 'pptCoverReuseHint' : 'pptCoverGenerateHint')}</span></button>)}</div>
              {draft.illustration === CoverIllustration.Generate && <>
                <label className="block text-xs text-secondary">{t('pptCoverSubject')}<textarea aria-label={t('pptCoverSubject')} maxLength={800} rows={3} value={draft.subject} disabled={disabled} onChange={event => setDraft(value => ({ ...value, subject: event.target.value }))} placeholder={t('pptCoverSubjectHint')} className={inputClass} /></label>
                <div className="rounded-lg bg-background p-3 text-xs leading-5 text-secondary"><p>{t('pptCoverModel')}{model?.displayName || catalog.coverImageModel || PptCover.DefaultImageModel}</p>{model?.unitCredits !== undefined && <p>{t('pptCoverUnitCredits').replace('{credits}', String(model.unitCredits))}</p>}<p>{model?.pricingDescription || t('pptCoverPriceUnknown')}</p><p className="mt-1 text-muted">{t('pptCoverCost')}</p></div>
                {modelError && <p role="alert" className="text-xs text-red-500">{modelError}</p>}
              </>}
            </>}
          </> : exported && <>
            <div role="status" data-cover-pptx={exported.path} data-cover-png={exported.pngPath} className="rounded-xl bg-primary-muted p-4 text-sm leading-6 text-foreground"><CheckIcon className="mb-2 h-6 w-6 text-primary" />{t('pptCoverExported')}</div>
            <div className="flex gap-4 text-sm text-primary"><button type="button" onClick={() => void window.electron.shell.openPath(exported.path)}>{t('pptCoverOpenPpt')}</button><button type="button" onClick={() => void window.electron.shell.showItemInFolder(exported.path)}>{t('pptCoverOpenFolder')}</button></div>
            <p className="text-xs leading-5 text-secondary">{t('pptCoverContinueHint')}</p>
            <button type="button" onClick={() => onContinue({ file: exported.file, fields: draft.fields, previewBase64: preview })} className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-white">{t('pptCoverContinue')}<ArrowRightIcon className="h-4 w-4" /></button>
          </>}
          {error && <p role="alert" className="text-xs leading-5 text-red-500">{error}</p>}
          {!background && !error && <p role="status" className="text-xs text-muted">{t('pptCoverChecking')}</p>}
          {step === CoverStep.Content && <button type="button" disabled={disabled || !background || !draft.fields.title.trim() || (draft.illustration === CoverIllustration.Generate && (!model || !draft.subject.trim()))} onClick={() => {
            if (draft.illustration === CoverIllustration.Generate && !matchingImage) void generate();
            else if (preview) { setStep(CoverStep.Preview); setError(''); }
          }} className="w-full rounded-xl bg-primary px-5 py-3 text-sm font-medium text-white disabled:opacity-50">{t(draft.illustration === CoverIllustration.Generate && !matchingImage ? 'pptCoverGenerateButton' : 'pptCoverNext')}</button>}
          {step === CoverStep.Preview && <>
            <button type="button" disabled={disabled || !preview} onClick={() => void exportCover()} className="w-full rounded-xl bg-primary px-5 py-3 text-sm font-medium text-white disabled:opacity-50">{t(busy ? 'pptCoverPreparing' : 'pptCoverExportButton')}</button>
            {draft.illustration === CoverIllustration.Generate && <button type="button" disabled={disabled || !model} onClick={() => void generate()} className="text-xs text-primary hover:underline">{t('pptCoverRegenerate')}</button>}
          </>}
          {step !== CoverStep.Content && <button type="button" disabled={disabled} onClick={() => { setStep(CoverStep.Content); setExported(undefined); }} className="block text-xs text-secondary hover:underline">{t('pptCoverBack')}</button>}
        </div>
      </div>
    </div>
  </Modal>;
}
