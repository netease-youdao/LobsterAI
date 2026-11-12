import './imageCreationScroll.css';

import { ArrowRightIcon, ArrowUpTrayIcon, ChevronDownIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { ImageCreation, type ImageCreationExample, type ImageExampleReference } from '../../../shared/imageCreation/constants';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import Modal from '../common/Modal';
import { computeMediaLabels } from '../cowork/mediaMentionUtils';
import { ModelAccessPromptKind, ModelAccessPromptModal } from '../ModelSelector';
import { useScrollAffordance } from './useScrollAffordance';

interface Props {
  example: ImageCreationExample;
  onClose: () => void;
  onUse: (prompt: string, reference?: ImageExampleReference) => Promise<boolean>;
}

export default function ImageExampleDialog({ example, onClose, onUse }: Props) {
  const t = (key: string) => i18nService.t(key);
  const language = i18nService.getLanguage();
  const [prompt, setPrompt] = useState(example.prompt[language]);
  const { scrollRef: promptRef, canScrollUp, canScrollDown, scrollNext } = useScrollAffordance<HTMLTextAreaElement>(prompt);
  const [reference, setReference] = useState<ImageExampleReference>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  const needsLogin = useSelector((state: RootState) => !state.auth.isLoggedIn
    && !state.model.availableModels.some(model => !model.isServerModel && model.accessible !== false));
  const mounted = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    mounted.current = true;
    closeButton.current?.focus();
    return () => { mounted.current = false; previous?.focus(); };
  }, []);

  const handleUseExample = async (useDemo: boolean) => {
    if (busy || !prompt.trim()) return;
    setError('');
    if (needsLogin) { setShowLoginPrompt(true); return; }
    setBusy(true);
    try {
      const selectedReference = useDemo ? await window.electron.imageCreation.getReference(example.id) : reference;
      if (!mounted.current) return;
      if (example.referenceImageUrl && !selectedReference) throw new Error('Reference required');
      const label = selectedReference && computeMediaLabels([{ name: selectedReference.name, path: selectedReference.name, isImage: true }])[0]?.label;
      const draftPrompt = label ? `@${label}\n\n${prompt.trim()}` : prompt.trim();
      const applied = await onUse(draftPrompt, selectedReference);
      if (mounted.current) {
        if (applied) onClose();
        else setError(t('imageCreationDraftChanged'));
      }
    } catch (failure) {
      console.warn('[ImageCreation] Could not prepare example:', failure);
      if (mounted.current) setError(t('imageCreationPrepareFailed'));
    } finally { if (mounted.current) setBusy(false); }
  };

  const chooseFile = async (file?: File) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > ImageCreation.MaxReferenceBytes) {
      setError(t('imageCreationInvalidImage')); return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
    });
    if (mounted.current) { setReference({ name: file.name, mimeType: file.type, base64Data: dataUrl.split(',')[1] }); setError(''); }
  };

  return <><Modal onClose={busy ? () => undefined : onClose} onEscape={busy ? undefined : onClose}
    className="w-[min(960px,calc(100vw-48px))] max-h-[calc(100vh-64px)] overflow-y-auto rounded-2xl border border-border bg-surface shadow-popover">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="image-example-title" className="relative grid md:grid-cols-2"
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea,input:not([type="file"])');
        if (!nodes?.length) return;
        const first = nodes[0]; const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <div className="flex min-h-64 items-center justify-center bg-surface-raised p-5 md:min-h-[510px]">
        <img src={example.imageUrl} alt={example.title[language]} className="max-h-[65vh] w-full rounded-lg object-contain" />
      </div>
      <div className="flex flex-col p-7">
        <button ref={closeButton} type="button" disabled={busy} onClick={onClose} aria-label={t('close')}
          className="absolute right-4 top-4 rounded-lg bg-surface/90 p-1.5 text-secondary hover:bg-surface-raised disabled:opacity-40"><XMarkIcon className="h-5 w-5" /></button>
        <p className="mb-2 text-xs font-medium text-primary">{t('imageCreationRealExample')}</p>
        <h2 id="image-example-title" className="pr-6 text-xl font-semibold text-foreground">{example.title[language]}</h2>
        <p className="mt-2 text-sm leading-6 text-secondary">{example.description[language]}</p>
        <div className="mb-2 mt-6 flex min-h-5 items-center justify-between gap-3 text-xs text-secondary">
          <label htmlFor="image-example-prompt" className="font-medium">{t('imageCreationPrompt')}</label>
          {canScrollDown && <button type="button" onClick={scrollNext} aria-controls="image-example-prompt" disabled={busy}
            className="flex shrink-0 items-center gap-1 rounded px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
            {t('imageCreationScrollPrompt')}<ChevronDownIcon aria-hidden="true" className="h-3 w-3" />
          </button>}
        </div>
        <div className="image-creation-prompt-scroll relative">
          <textarea ref={promptRef} id="image-example-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={busy}
            className="image-creation-scrollbar block h-40 w-full resize-none rounded-xl border border-border bg-background p-3 text-sm leading-6 text-foreground focus:border-primary focus:outline-none" />
          {canScrollUp && <div aria-hidden="true" className="image-creation-prompt-fade image-creation-prompt-fade-top" />}
          {canScrollDown && <div aria-hidden="true" className="image-creation-prompt-fade image-creation-prompt-fade-bottom" />}
        </div>
        {example.referenceImageUrl && <div className="mt-4 rounded-xl border border-border p-3">
          <p className="mb-2 text-xs font-medium text-foreground">{t('imageCreationReferenceNeeded')}</p>
          <div className="flex items-center gap-3">
            <img src={reference ? `data:${reference.mimeType};base64,${reference.base64Data}` : example.referenceImageUrl}
              alt={t('imageCreationReference')} className="h-14 w-14 rounded-lg object-cover" />
            <div className="min-w-0 flex-1"><p className="truncate text-xs text-secondary">{reference?.name || t('imageCreationDemoReference')}</p>
              <button type="button" disabled={busy} onClick={() => fileInput.current?.click()} className="mt-1 flex items-center gap-1 text-sm text-primary hover:underline"><ArrowUpTrayIcon className="h-4 w-4" />{t('imageCreationUpload')}</button></div>
          </div>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" aria-label={t('imageCreationUpload')}
            className="hidden" onChange={event => { void chooseFile(event.target.files?.[0]).catch(() => setError(t('imageCreationInvalidImage'))); event.target.value = ''; }} />
        </div>}
        {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
        <div className="mt-5 flex flex-wrap gap-2">
          {example.referenceImageUrl && !reference ? <>
            <button type="button" disabled={busy || !prompt.trim()} onClick={() => void handleUseExample(true)} className="flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-white disabled:opacity-50">{busy ? t('imageCreationPreparing') : t('imageCreationUseDemo')}<ArrowRightIcon className="h-4 w-4" /></button>
            <button type="button" disabled={busy} onClick={() => fileInput.current?.click()} className="rounded-xl border border-border px-4 py-3 text-sm text-foreground hover:bg-surface-raised">{t('imageCreationUseOwn')}</button>
          </> : <button type="button" disabled={busy || !prompt.trim()} onClick={() => void handleUseExample(false)} className="flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-white disabled:opacity-50">{busy ? t('imageCreationPreparing') : t('imageCreationRemix')}<ArrowRightIcon className="h-4 w-4" /></button>}
        </div>
        <p className="mt-3 text-xs leading-5 text-muted">{t('imageCreationDraftHint')}</p>
        <p className="mt-auto pt-5 text-[11px] text-muted">{t('imageCreationModelLabel')} {example.modelName}</p>
      </div>
    </div>
  </Modal>
    {showLoginPrompt && needsLogin && <ModelAccessPromptModal promptKind={ModelAccessPromptKind.Login}
      titleKey="imageCreationLoginTitle" descriptionKey="imageCreationLoginDescription" showLearnMore={false}
      onClose={() => setShowLoginPrompt(false)} />}
  </>;
}
