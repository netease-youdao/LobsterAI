import { ArrowRightIcon, ArrowUpTrayIcon, XMarkIcon } from '@heroicons/react/24/outline';
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
const inputClass = 'scrollbar-hidden w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none disabled:opacity-50';
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

export default function PptExampleDialog({ catalog, example, onClose, onUse, onCover, coverSeed }: {
  catalog: PptCatalog; example: PptExample; onClose: () => void; onUse: (example: PptExample, options: PptDraftOptions) => Promise<boolean>;
  onCover?: () => void; coverSeed?: PptCoverSeed;
}) {
  const t = (key: string) => i18nService.t(key);
  const language = i18nService.getLanguage();
  const [mode, setMode] = useState<PptExampleMode>(coverSeed ? PptExampleMode.Guided : example.defaultMode);
  const [slide, setSlide] = useState(0);
  const [prompt, setPrompt] = useState(example.prompt[language]);
  const [topic, setTopic] = useState(coverSeed ? `${coverSeed.fields.title}\n${coverSeed.fields.subtitle}` : '');
  const [audience, setAudience] = useState('');
  const [slideCount, setSlideCount] = useState(example.slideCount);
  const [useDemo, setUseDemo] = useState(false);
  const [templateId, setTemplateId] = useState(coverSeed ? '' : example.templateId ?? '');
  const [workflow, setWorkflow] = useState<PptWorkflow>(coverSeed ? PptWorkflow.Generate : example.defaultWorkflow);
  const [files, setFiles] = useState<PptPreparedFile[]>(coverSeed ? [coverSeed.file] : []);
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
  return <Modal onClose={dismiss} onEscape={dismiss} className="w-[min(1080px,94vw)] rounded-2xl border border-border bg-surface shadow-float">
    <div role="dialog" aria-modal="true" aria-labelledby="ppt-example-title" data-ppt-example-dialog className="relative flex h-[min(780px,90vh)] flex-col overflow-hidden rounded-2xl p-5 md:p-7"
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type=file]), textarea:not(:disabled), select:not(:disabled)'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
      }}>
      <div className="shrink-0">
      <button ref={close} type="button" disabled={busy} onClick={dismiss} aria-label={t('close')} className="absolute right-4 top-4 z-10 rounded-lg bg-surface p-1.5 text-secondary hover:bg-surface-raised disabled:opacity-40"><XMarkIcon className="h-5 w-5" /></button>
      <p className="mb-2 text-xs text-primary">{t('pptCreationReal')}</p>
      <h2 id="ppt-example-title" className="pr-8 text-xl font-semibold text-foreground">{example.title[language]}</h2>
      <p className="mt-2 text-sm text-secondary">{coverSeed ? t('pptCoverContinueHint') : example.description[language]}</p>
      </div>
      <div className="scrollbar-hidden mt-5 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto md:grid md:grid-cols-2 md:overflow-hidden">
        <div className="scrollbar-hidden min-h-0 shrink-0 md:overflow-y-auto md:overscroll-contain">
          <PptPreviewImage url={coverSeed ? `data:image/png;base64,${coverSeed.previewBase64}` : example.previews[slide].url} alt={coverSeed ? coverSeed.fields.title : `${example.title[language]} · ${t('pptCreationPage').replace('{page}', String(example.previews[slide].slide))}`} className="aspect-video border border-border-subtle" />
          {!coverSeed && <div className="mt-3 flex gap-2">{example.previews.map((preview, index) => <button type="button" key={preview.slide} onClick={() => setSlide(index)} aria-pressed={slide === index}
            className={`min-w-0 flex-1 rounded-lg border p-1 ${slide === index ? 'border-primary' : 'border-border-subtle'}`}>
            <PptPreviewImage url={preview.url} alt={t('pptCreationPage').replace('{page}', String(preview.slide))} className="aspect-video rounded" />
          </button>)}</div>}
          <p className="mt-3 text-xs text-muted">{coverSeed ? t('pptCoverConfirmed') : t('pptCreationPages').replace('{count}', String(example.slideCount))} · {t('pptCreationModel')}{modelPresetName(catalog.recommendedModelPreset)}</p>
          <p className="mt-4 rounded-lg bg-background p-3 text-xs leading-5 text-muted">{t('pptCreationDemoHint')}</p>
          {example.cover && onCover && !coverSeed && <button type="button" disabled={busy} onClick={onCover} className="mt-4 w-full rounded-xl border border-primary bg-primary-muted px-4 py-3 text-sm font-medium text-primary">{t('pptCoverEntry')}</button>}
          {coverSeed && <p className="mt-4 rounded-lg bg-primary-muted p-3 text-xs leading-5 text-primary">{t('pptCoverContinueHint')}</p>}
        </div>
        <div className="flex min-h-[30rem] shrink-0 flex-col gap-4 md:min-h-0">
          <div className="flex shrink-0 gap-2" role="group" aria-label={t('pptCreationWorkflow')}>{(coverSeed ? [PptExampleMode.Guided] : [PptExampleMode.Direct, PptExampleMode.Guided]).map(value => <button key={value} type="button" disabled={busy} aria-pressed={mode === value} onClick={() => { setMode(value); setError(''); }}
            className={`rounded-full border px-4 py-2 text-sm ${mode === value ? 'border-primary bg-primary-muted text-primary' : 'border-border text-secondary'}`}>{t(value === PptExampleMode.Direct ? 'pptCreationDirect' : 'pptCreationGuided')}</button>)}</div>
          <div key={mode} data-ppt-example-content className="scrollbar-hidden min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">
          {direct ? <label className="flex h-full min-h-56 flex-col text-xs font-medium text-secondary">{t('pptCreationPrompt')}<textarea aria-label={t('pptCreationPrompt')} value={prompt} onChange={event => setPrompt(event.target.value)} disabled={busy} className={`${inputClass} mt-2 min-h-48 flex-1 leading-6`} /></label> : <>
            {!coverSeed && <label className="flex items-center gap-2 text-sm text-foreground"><input type="checkbox" checked={useDemo} disabled={busy} onChange={event => setUseDemo(event.target.checked)} />{t('pptCreationDemo')}</label>}
            <label className="block text-xs font-medium text-secondary">{t('pptCreationTopic')}<textarea aria-label={t('pptCreationTopic')} value={topic} onChange={event => setTopic(event.target.value)} placeholder={t('pptCreationTopicPlaceholder')} disabled={busy} className={`${inputClass} mt-2 h-24`} /></label>
            <div className="grid grid-cols-[1fr_100px] gap-3">
              <label className="block text-xs text-secondary">{t('pptCreationAudience')}<input value={audience} onChange={event => setAudience(event.target.value)} disabled={busy} className={`${inputClass} mt-1`} /></label>
              <label className="block text-xs text-secondary">{t('pptCreationSlideCount')}<input type="number" min={3} max={40} value={slideCount} disabled={busy} onChange={event => setSlideCount(Number(event.target.value))} className={`${inputClass} mt-1`} /></label>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs font-medium text-secondary">{t('pptCreationMaterials')}</p>
              {existing.length > 0 && <p className="mt-2 text-xs text-muted">{t('pptCreationExistingFiles').replace('{count}', String(existing.length))}</p>}
              {useDemo && example.materials.map(file => <p key={file.id} className="mt-2 truncate text-xs text-secondary">{file.name}</p>)}
              {files.map((file, index) => <div key={`${file.name}-${index}`} className="mt-2 flex items-center justify-between gap-2 text-xs text-secondary"><span className="truncate">{file.name}</span>{file !== coverSeed?.file && <button type="button" disabled={busy} aria-label={t('pptCreationRemoveFile').replace('{name}', file.name)} onClick={() => setFiles(items => items.filter((_, position) => position !== index))}><XMarkIcon className="h-4 w-4" /></button>}</div>)}
              <button type="button" disabled={busy} onClick={() => upload.current?.click()} className="mt-3 flex items-center gap-1 text-sm text-primary"><ArrowUpTrayIcon className="h-4 w-4" />{t('pptCreationAddFiles')}</button>
              <input ref={upload} type="file" multiple accept=".pptx,.docx,.xlsx,.pdf,.txt,.csv,.md" className="hidden" aria-label={t('pptCreationAddFiles')} onChange={event => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
              <p className="mt-2 text-xs leading-5 text-muted">{t('pptCreationFilesHint')}</p>
            </div>
            {!coverSeed && <label className="block text-xs text-secondary">{t('pptCreationTemplate')}<select value={templateId} disabled={busy} onChange={event => setTemplateId(event.target.value)} className={`${inputClass} mt-1`}>
              <option value="">{t('pptCreationNoTemplate')}</option><option value={OWN_TEMPLATE}>{t('pptCreationOwnTemplate')}</option>
              {catalog.templates.map(template => <option key={template.id} value={template.id}>{template.title[language]}</option>)}
            </select></label>}
            {selectedTemplate && <div className="flex items-center gap-3 rounded-lg bg-background p-2">
              <PptPreviewImage url={selectedTemplate.previewUrl} alt="" className="aspect-video w-28 shrink-0" />
              <span className="text-xs leading-5 text-secondary">{selectedTemplate.description[language]}</span>
            </div>}
            {!coverSeed && <p className="text-xs leading-5 text-muted">{t('pptCreationTemplateHint')}</p>}
            <label className="block text-xs text-secondary">{t('pptCreationWorkflow')}<select value={workflow} disabled={busy} onChange={event => setWorkflow(event.target.value as PptWorkflow)} className={`${inputClass} mt-1`}>
              <option value={PptWorkflow.Generate}>{t('pptCreationGenerate')}</option><option value={PptWorkflow.Outline}>{t('pptCreationOutline')}</option>{!coverSeed && <option value={PptWorkflow.Strict}>{t('pptCreationStrict')}</option>}
            </select></label>
            {workflow !== PptWorkflow.Generate && <p className="text-xs text-muted">{t(workflow === PptWorkflow.Outline ? 'pptCreationOutlineHint' : 'pptCreationStrictHint')}</p>}
          </>}
          </div>
          <div data-ppt-example-actions className="shrink-0 space-y-2 border-t border-border-subtle pt-4">
          {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
          <button type="button" disabled={busy || (direct ? !prompt.trim() : !Number.isInteger(slideCount) || slideCount < 3 || slideCount > 40)} onClick={() => void submit()}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-white disabled:opacity-50">{busy ? t('pptCreationPreparing') : t(coverSeed ? 'pptCreationContinue' : 'pptCreationFill')}<ArrowRightIcon className="h-4 w-4" /></button>
          <p className="text-xs leading-5 text-muted">{t('pptCreationDraftHint')}</p>
          </div>
        </div>
      </div>
    </div>
  </Modal>;
}
