import { ArrowLeftIcon, ArrowRightIcon, ArrowUpTrayIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { PptAssetKind, type PptCatalog, PptCreation, PptCreationError, type PptExample, PptExampleMode, type PptPreparedFile, PptWorkflow } from '../../../shared/pptCreation/constants';
import { i18nService } from '../../services/i18n';
import { modelPresetName } from '../../services/modelPresets';
import type { PptDraftOptions } from '../../services/pptCreationDraft';
import { buildPptCreationPrompt, buildPptDirectPrompt } from '../../services/pptCreationPrompt';
import { buildCoverContinuationPrompt } from '../../services/pptCreationPrompt';
import type { RootState } from '../../store';
import Modal from '../common/Modal';
import type { PptCoverSeed } from './PptCoverWizard';
import { PptPreviewImage } from './PptExampleGallery';

const OWN_TEMPLATE = 'uploaded';
const inputClass = 'scrollbar-hidden min-h-11 w-full resize-none rounded-xl border border-border-input bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-foreground/45 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-50';
async function readMaterial(file: File): Promise<PptPreparedFile> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!file.size || file.size > PptCreation.MaxAssetBytes || !Object.values(PptAssetKind).includes(extension as PptAssetKind)) throw new Error('Invalid PPT material');
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return { name: file.name, mimeType: file.type || 'application/octet-stream', base64Data: data };
}

export interface PptExampleDialogState {
  mode: PptExampleMode;
  slide: number;
  prompt: string;
  topic: string;
  audience: string;
  slideCount: number;
  useDemo: boolean;
  templateId: string;
  workflow: PptWorkflow;
  files: PptPreparedFile[];
}

export default function PptExampleDialog({ catalog, example, onClose, onUse, onCover, onBack, backLabel, coverSeed, initialState }: {
  catalog: PptCatalog; example: PptExample; onClose: () => void; onUse: (example: PptExample, options: PptDraftOptions) => Promise<boolean>;
  onCover?: (state: PptExampleDialogState) => void; onBack?: () => void; backLabel?: string;
  coverSeed?: PptCoverSeed; initialState?: PptExampleDialogState;
}) {
  const t = (key: string) => i18nService.t(key);
  const language = i18nService.getLanguage();
  const [mode, setMode] = useState<PptExampleMode>(coverSeed ? PptExampleMode.Guided : (initialState?.mode ?? example.defaultMode));
  const [slide, setSlide] = useState(() => Math.min(Math.max(initialState?.slide ?? 0, 0), Math.max(example.previews.length - 1, 0)));
  const [prompt, setPrompt] = useState(initialState?.prompt ?? example.prompt[language]);
  const [topic, setTopic] = useState(coverSeed ? `${coverSeed.fields.title}\n${coverSeed.fields.subtitle}` : (initialState?.topic ?? ''));
  const [audience, setAudience] = useState(coverSeed ? '' : (initialState?.audience ?? ''));
  const [slideCount, setSlideCount] = useState(coverSeed ? example.slideCount : (initialState?.slideCount ?? example.slideCount));
  const [useDemo, setUseDemo] = useState(coverSeed ? false : (initialState?.useDemo ?? false));
  const [templateId, setTemplateId] = useState(coverSeed ? '' : (initialState?.templateId ?? example.templateId ?? ''));
  const [workflow, setWorkflow] = useState<PptWorkflow>(coverSeed ? PptWorkflow.Generate : (initialState?.workflow ?? example.defaultWorkflow));
  const [files, setFiles] = useState<PptPreparedFile[]>(coverSeed ? [coverSeed.file] : (initialState?.files ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const upload = useRef<HTMLInputElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const draftAttachments = useSelector((state: RootState) => state.cowork.draftAttachments[PptCreation.HomeDraft]);
  const existing = draftAttachments ?? [];
  const selectedTemplate = catalog.templates.find(template => template.id === templateId);
  const direct = mode === PptExampleMode.Direct;
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => { mounted.current = false; previous?.focus(); };
  }, []);

  const addFiles = async (selected: File[]) => {
    if (files.length + selected.length > PptCreation.MaxAttachments) { setError(t('pptCreationInvalidFile')); return; }
    setBusy(true); setError('');
    try {
      const prepared = await Promise.all(selected.map(readMaterial));
      if (mounted.current) setFiles(previous => [...previous, ...prepared]);
    } catch { if (mounted.current) setError(t('pptCreationInvalidFile')); }
    finally { if (mounted.current) setBusy(false); }
  };
  const submit = async () => {
    if (busy) return;
    const demo = direct || useDemo;
    const attachmentCount = existing.length + (direct ? 0 : files.length)
      + (demo ? example.materials.length : 0) + ((direct ? example.templateId : selectedTemplate?.id) ? 1 : 0);
    if (attachmentCount > PptCreation.MaxAttachments) { setError(t('pptCreationInvalidFile')); return; }
    if (!direct && !demo && !topic.trim() && !files.length && !existing.length) { setError(t('pptCreationNeedContent')); return; }
    const hasPpt = [...files, ...existing].some(file => file.name.toLowerCase().endsWith('.pptx'))
      || (demo && example.materials.some(file => file.kind === PptAssetKind.Pptx));
    if (!direct && (workflow === PptWorkflow.Strict || templateId === OWN_TEMPLATE) && !hasPpt) { setError(t('pptCreationNeedPpt')); return; }
    let text = direct ? buildPptDirectPrompt(prompt, language, catalog.templates.find(template => template.id === example.templateId)?.file.name) : buildPptCreationPrompt(example, {
      language, useDemo, topic, audience, slideCount, workflow,
      templateName: selectedTemplate?.file.name ?? (templateId === OWN_TEMPLATE ? t('pptCreationOwnTemplate') : undefined),
      sourceDeck: templateId === OWN_TEMPLATE,
    });
    if (coverSeed && files.includes(coverSeed.file)) text = buildCoverContinuationPrompt(text, coverSeed.file.name, language);
    if (!text) return;
    setBusy(true); setError('');
    try {
      const applied = await onUse(example, { prompt: text, mode, workflow: direct ? PptWorkflow.Generate : workflow,
        useDemo: demo, templateId: direct ? example.templateId : selectedTemplate?.id, files: direct ? [] : files });
      if (mounted.current) { if (applied) onClose(); else setError(t('pptCreationDraftChanged')); }
    } catch (failure) {
      console.warn('[PptCreation] Could not prepare draft:', failure);
      if (mounted.current) setError(t(failure instanceof Error && failure.message === PptCreationError.ModelUnavailable ? 'pptCreationModelUnavailable' : 'pptCreationPrepareFailed'));
    } finally { if (mounted.current) setBusy(false); }
  };
  const dismiss = () => { if (!busy) onClose(); };
  // The dialog can overlap the Electron window's draggable header.
  return <Modal onClose={dismiss} onEscape={dismiss} className="non-draggable w-[min(1080px,94vw)] overflow-hidden rounded-3xl border border-border bg-surface shadow-modal">
    <div role="dialog" aria-modal="true" aria-labelledby="ppt-example-title" data-ppt-example-dialog className="flex h-[min(800px,92vh)] flex-col overflow-hidden"
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type=file]), textarea:not(:disabled), select:not(:disabled)'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
      }}>
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-5 md:px-7">
        <div className="min-w-0">
          {onBack && backLabel ? (
            <button type="button" disabled={busy} onClick={onBack}
              className="group mb-2 inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-lg border border-border/80 bg-surface-raised/60 px-2.5 py-1 text-xs font-medium text-foreground/80 transition-colors hover:border-primary/40 hover:bg-primary-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40">
              <ArrowLeftIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:-translate-x-0.5 motion-reduce:transition-none" />
              <span className="truncate">{backLabel}</span>
            </button>
          ) : (
            <p className="mb-1.5 text-xs font-medium text-foreground/60">{t('pptCreationReal')}</p>
          )}
          <h2 id="ppt-example-title" className="text-xl font-semibold text-foreground">{example.title[language]}</h2>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-foreground/70">{coverSeed ? t('pptCoverContinueHint') : example.description[language]}</p>
        </div>
        <button ref={close} type="button" disabled={busy} onClick={dismiss} aria-label={t('close')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40"><XMarkIcon aria-hidden="true" className="h-5 w-5" /></button>
      </div>
      <div className="scrollbar-hidden flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[1.08fr_1fr] md:overflow-hidden">
        <div className="scrollbar-hidden min-h-0 min-w-0 shrink-0 bg-surface-raised/60 p-5 md:overflow-y-auto md:overscroll-contain md:p-6">
          <div data-ppt-example-preview className={coverSeed ? '' : 'md:flex md:h-full md:max-h-[calc(32vh+12rem)] md:flex-col'}>
            <div className="mb-3 flex min-h-9 shrink-0 flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-foreground/70">{t(coverSeed ? 'pptCoverConfirmed' : 'pptCreationExamplePreview')}</p>
              {example.cover && onCover && !coverSeed && <button type="button" disabled={busy} onClick={() => onCover({ mode, slide, prompt, topic, audience, slideCount, useDemo, templateId, workflow, files })} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">{t('pptCoverEntry')}<ArrowRightIcon aria-hidden="true" className="h-3.5 w-3.5" /></button>}
            </div>
            <div className={coverSeed ? '' : 'md:flex md:min-h-0 md:max-h-[32vh] md:flex-1 md:items-center md:justify-center'}>
              <PptPreviewImage url={coverSeed ? `data:image/png;base64,${coverSeed.previewBase64}` : example.previews[slide].url} alt={coverSeed ? coverSeed.fields.title : `${example.title[language]} · ${t('pptCreationPage').replace('{page}', String(example.previews[slide].slide))}`} className={`mx-auto aspect-video max-h-[32vh] border border-border bg-surface shadow-card ${coverSeed ? '' : 'md:h-full md:max-h-full md:max-w-full'}`} />
            </div>
            {!coverSeed && <div className="mt-3 flex shrink-0 gap-2" role="group" aria-label={t('pptCreationExamplePreview')}>{example.previews.map((preview, index) => <button type="button" key={preview.slide} onClick={() => setSlide(index)} aria-pressed={slide === index}
              aria-label={t('pptCreationPage').replace('{page}', String(preview.slide))}
              className={`min-w-0 flex-1 rounded-xl border p-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${slide === index ? 'border-primary bg-primary-muted text-primary' : 'border-transparent text-foreground/65 hover:border-border hover:bg-surface'}`}>
              <PptPreviewImage url={preview.url} alt="" className="aspect-video rounded-md" />
              <span className="mt-1.5 block text-xs leading-4">{t('pptCreationPage').replace('{page}', String(preview.slide))}</span>
            </button>)}</div>}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-foreground/70 md:mt-6">
            <span className="rounded-md border border-border bg-surface px-2 py-1">{coverSeed ? t('pptCoverConfirmed') : t('pptCreationPages').replace('{count}', String(example.slideCount))}</span>
            <span>{t('pptCreationModel')}<span className="font-medium text-foreground">{modelPresetName(catalog.recommendedModelPreset)}</span></span>
          </div>
          <p className="mt-4 text-xs leading-5 text-foreground/60">{t('pptCreationDemoHint')}</p>
          {coverSeed && <p className="mt-4 rounded-xl border border-primary/15 bg-primary-muted p-3 text-xs leading-5 text-foreground/80">{t('pptCoverContinueHint')}</p>}
        </div>
        <div className="flex min-h-[25rem] min-w-0 shrink-0 flex-col gap-5 border-t border-border p-5 md:min-h-0 md:border-l md:border-t-0 md:p-6">
          <div className={`grid shrink-0 gap-1 rounded-2xl bg-surface-raised p-1 ${coverSeed ? 'grid-cols-1' : 'grid-cols-2'}`} role="group" aria-label={t('pptCreationWorkflow')}>
            {(coverSeed ? [PptExampleMode.Guided] : [PptExampleMode.Direct, PptExampleMode.Guided]).map(value => <button key={value} type="button" disabled={busy} aria-pressed={mode === value} onClick={() => { setMode(value); setError(''); }}
              className={`min-w-0 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${mode === value ? 'border-border bg-surface shadow-subtle' : 'border-transparent hover:bg-surface/60'}`}>
              <span className={`block text-sm font-medium ${mode === value ? 'text-primary' : 'text-foreground/75'}`}>{t(value === PptExampleMode.Direct ? 'pptCreationDirect' : 'pptCreationGuided')}</span>
              <span className="mt-0.5 block text-xs leading-5 text-foreground/65">{t(value === PptExampleMode.Direct ? 'pptCreationDirectHint' : 'pptCreationGuidedHint')}</span>
            </button>)}
          </div>
          <div key={mode} data-ppt-example-content className="scrollbar-hidden min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-0.5 pb-1">
            {direct ? <label className="flex h-full min-h-56 flex-col text-sm font-medium text-foreground">
              {t('pptCreationPrompt')}<span className="mt-1 text-xs font-normal leading-5 text-foreground/65">{t('pptCreationPromptHint')}</span>
              <textarea aria-label={t('pptCreationPrompt')} value={prompt} onChange={event => setPrompt(event.target.value)} disabled={busy} className={`${inputClass} mt-3 min-h-40 flex-1 font-normal leading-6`} />
            </label> : <>
              {!coverSeed && <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl bg-surface-raised px-3 py-2 text-sm text-foreground"><input type="checkbox" checked={useDemo} disabled={busy} onChange={event => setUseDemo(event.target.checked)} className="h-4 w-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2" />{t('pptCreationDemo')}</label>}
              <label className="block text-sm font-medium text-foreground">{t('pptCreationTopic')}<textarea aria-label={t('pptCreationTopic')} value={topic} onChange={event => setTopic(event.target.value)} placeholder={t('pptCreationTopicPlaceholder')} disabled={busy} className={`${inputClass} mt-2 h-28 font-normal`} /></label>
              <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-3">
                <label className="block text-xs font-medium text-foreground/80">{t('pptCreationAudience')}<input value={audience} onChange={event => setAudience(event.target.value)} disabled={busy} className={`${inputClass} mt-2`} /></label>
                <label className="block text-xs font-medium text-foreground/80">{t('pptCreationSlideCount')}<input type="number" min={3} max={40} value={slideCount} disabled={busy} onChange={event => setSlideCount(Number(event.target.value))} className={`${inputClass} mt-2`} /></label>
              </div>
              <div className="rounded-xl border border-border p-3.5">
                <p className="text-sm font-medium text-foreground">{t('pptCreationMaterials')}</p>
                {existing.length > 0 && <p className="mt-2 text-xs leading-5 text-foreground/65">{t('pptCreationExistingFiles').replace('{count}', String(existing.length))}</p>}
                {useDemo && example.materials.map(file => <p key={file.id} className="mt-2 break-all rounded-lg bg-surface-raised px-3 py-2 text-xs text-foreground/75">{file.name}</p>)}
                {files.map((file, index) => <div key={`${file.name}-${index}`} className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-surface-raised pl-3 text-xs text-foreground/75"><span className="min-w-0 break-all py-2">{file.name}</span>{file !== coverSeed?.file && <button type="button" disabled={busy} aria-label={t('pptCreationRemoveFile').replace('{name}', file.name)} onClick={() => setFiles(items => items.filter((_, position) => position !== index))} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><XMarkIcon aria-hidden="true" className="h-4 w-4" /></button>}</div>)}
                <button type="button" disabled={busy} onClick={() => upload.current?.click()} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-foreground/20 text-sm text-foreground/80 transition-colors hover:border-primary/50 hover:bg-primary-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"><ArrowUpTrayIcon aria-hidden="true" className="h-4 w-4" />{t('pptCreationAddFiles')}</button>
                <input ref={upload} type="file" multiple accept=".pptx,.docx,.xlsx,.pdf,.txt,.csv,.md" className="hidden" aria-label={t('pptCreationAddFiles')} onChange={event => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
                <p className="mt-2 text-xs leading-5 text-foreground/60">{t('pptCreationFilesHint')}</p>
              </div>
              {!coverSeed && <label className="block text-xs font-medium text-foreground/80">{t('pptCreationTemplate')}<select value={templateId} disabled={busy} onChange={event => setTemplateId(event.target.value)} className={`${inputClass} mt-2`}>
                <option value="">{t('pptCreationNoTemplate')}</option><option value={OWN_TEMPLATE}>{t('pptCreationOwnTemplate')}</option>
                {catalog.templates.map(template => <option key={template.id} value={template.id}>{template.title[language]}</option>)}
              </select></label>}
              {selectedTemplate && <div className="flex items-center gap-3 rounded-xl bg-surface-raised p-3">
                <PptPreviewImage url={selectedTemplate.previewUrl} alt="" className="aspect-video w-24 shrink-0" />
                <span className="text-xs leading-5 text-foreground/70">{selectedTemplate.description[language]}</span>
              </div>}
              {!coverSeed && <p className="text-xs leading-5 text-foreground/60">{t('pptCreationTemplateHint')}</p>}
              <label className="block text-xs font-medium text-foreground/80">{t('pptCreationWorkflow')}<select value={workflow} disabled={busy} onChange={event => setWorkflow(event.target.value as PptWorkflow)} className={`${inputClass} mt-2`}>
                <option value={PptWorkflow.Generate}>{t('pptCreationGenerate')}</option><option value={PptWorkflow.Outline}>{t('pptCreationOutline')}</option>{!coverSeed && <option value={PptWorkflow.Strict}>{t('pptCreationStrict')}</option>}
              </select></label>
              {workflow !== PptWorkflow.Generate && <p className="text-xs leading-5 text-foreground/65">{t(workflow === PptWorkflow.Outline ? 'pptCreationOutlineHint' : 'pptCreationStrictHint')}</p>}
            </>}
          </div>
        </div>
      </div>
      <div data-ppt-example-actions className="grid shrink-0 items-center gap-3 border-t border-border bg-surface px-5 py-4 md:grid-cols-[1.08fr_1fr] md:gap-12 md:px-6">
        <p className="order-2 text-xs leading-5 text-foreground/65 md:order-1">{t('pptCreationDraftHint')}</p>
        <div className="order-1 min-w-0 space-y-2 md:order-2">
          {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">{error}</p>}
          <button type="button" disabled={busy || (direct ? !prompt.trim() : !Number.isInteger(slideCount) || slideCount < 3 || slideCount > 40)} onClick={() => void submit()}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50">{busy ? t('pptCreationPreparing') : t(coverSeed ? 'pptCreationContinue' : 'pptCreationFill')}<ArrowRightIcon aria-hidden="true" className="h-4 w-4 shrink-0" /></button>
        </div>
      </div>
    </div>
  </Modal>;
}
