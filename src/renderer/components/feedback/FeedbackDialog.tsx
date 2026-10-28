import { ArrowPathIcon, CheckCircleIcon, PhotoIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';

import { FEEDBACK_IMAGE_TYPES, FEEDBACK_LIMITS, FEEDBACK_PRIVACY_URL, FeedbackCategory, FeedbackError } from '../../../shared/feedback/constants';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import ImagePreviewModal from '../cowork/ImagePreviewModal';
import { getFeedbackImagePreviewUrl } from './feedbackImagePreview';

type SelectedImage = { id: string; file: File; url: string };
const categoryLabels = {
  [FeedbackCategory.Issue]: 'feedbackIssue',
  [FeedbackCategory.Suggestion]: 'feedbackSuggestion',
  [FeedbackCategory.AiReport]: 'feedbackAiReport',
} as const;
const errorLabels = {
  [FeedbackError.Invalid]: 'feedbackInvalid',
  [FeedbackError.Unauthorized]: 'feedbackLoginRequired',
  [FeedbackError.RateLimited]: 'feedbackRateLimited',
  [FeedbackError.Failed]: 'feedbackFailed',
  [FeedbackError.LogsTooLarge]: 'feedbackLogsTooLarge',
} as const;

export default function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const t = (key: string) => i18nService.t(key);
  const [category, setCategory] = useState<FeedbackCategory>(FeedbackCategory.Issue);
  const [content, setContent] = useState('');
  const [images, setImages] = useState<SelectedImage[]>([]);
  const [previewImage, setPreviewImage] = useState<SelectedImage | null>(null);
  const [includeLogs, setIncludeLogs] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [submittedId, setSubmittedId] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [dragging, setDragging] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const imageRef = useRef(images);
  imageRef.current = images;
  const previewUrl = previewImage ? getFeedbackImagePreviewUrl(previewImage.url) : undefined;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector('textarea')?.focus();
    return () => {
      imageRef.current.forEach(image => URL.revokeObjectURL(image.url));
      previous?.focus();
    };
  }, []);

  const changed = () => {
    requestId.current = crypto.randomUUID();
    setError(null);
    setNeedsLogin(false);
  };
  const close = () => {
    if (submitting) return;
    if (submittedId === null && (content.trim() || images.length)) setConfirmDiscard(true);
    else onClose();
  };
  const addImages = (files: File[]) => {
    if (submitting) return;
    if (images.length + files.length > FEEDBACK_LIMITS.images) { setError(t('feedbackImageCountError')); return; }
    if (files.some(file => !FEEDBACK_IMAGE_TYPES.some(type => type === file.type))) { setError(t('feedbackImageTypeError')); return; }
    if (files.some(file => file.size === 0 || file.size > FEEDBACK_LIMITS.imageBytes)) { setError(t('feedbackImageSizeError')); return; }
    if ([...images.map(image => image.file), ...files].reduce((total, file) => total + file.size, 0) > FEEDBACK_LIMITS.totalImageBytes) {
      setError(t('feedbackImageTotalError')); return;
    }
    changed();
    setImages(current => [...current, ...files.map(file => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }))]);
  };
  const submit = async () => {
    if (submitting || !content.trim()) return;
    setSubmitting(true);
    setError(null);
    setNeedsLogin(false);
    try {
      const result = await window.electron.feedback.submit({
        requestId: requestId.current, category, content, includeLogs,
        images: await Promise.all(images.map(async ({ file }) => ({
          name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()),
        }))),
      });
      if (result.success) setSubmittedId(result.id);
      else {
        setError(t(errorLabels[result.error]));
        setNeedsLogin(result.error === FeedbackError.Unauthorized);
      }
    } catch {
      setError(t('feedbackFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={close} onEscape={close} overlayClassName="fixed inset-0 z-[70] modal-backdrop flex items-center justify-center p-4" className="w-full max-w-[560px]">
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="feedback-title"
        className="max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-background px-6 pb-5 pt-5 shadow-modal"
        onKeyDown={event => {
          if (event.key !== 'Tab') return;
          const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled):not([type=file]), a[href]') ?? []);
          const last = elements[elements.length - 1];
          const target = event.shiftKey ? last : elements[0];
          if (event.shiftKey ? document.activeElement === elements[0] : document.activeElement === last) {
            event.preventDefault(); target?.focus();
          }
        }}>
        <header className="mb-4 flex items-center justify-between gap-4">
          <h2 id="feedback-title" className="min-w-0 text-base font-semibold text-foreground">{t('feedbackTitle')}</h2>
          <button type="button" onClick={close} disabled={submitting} aria-label={t('close')} className="-mr-1.5 rounded-md p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-40"><XMarkIcon className="h-4 w-4" /></button>
        </header>

        {submittedId !== null ? (
          <div role="status" className="pb-2 pt-6 text-center">
            <CheckCircleIcon className="mx-auto h-10 w-10 text-emerald-500" />
            <h3 className="mt-3 text-sm font-semibold text-foreground">{t('feedbackSuccess')}</h3>
            <p className="mt-1.5 text-xs text-secondary">{t('feedbackSuccessDescription')}</p>
            <p className="mt-1 text-xs tabular-nums text-muted">{t('feedbackReference')} #{submittedId}</p>
            <button type="button" onClick={onClose} className="mt-6 h-8 rounded-lg bg-primary px-6 text-[13px] font-medium text-white transition-colors hover:bg-primary-hover">{t('feedbackDone')}</button>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label={t('feedbackCategory')}>
              {Object.values(FeedbackCategory).map(value => (
                <button type="button" key={value} disabled={submitting} aria-pressed={category === value}
                  onClick={() => { changed(); setCategory(value); }}
                  className={`h-7 rounded-md px-2.5 text-[13px] transition-colors disabled:cursor-not-allowed ${category === value ? 'bg-foreground/[0.07] font-medium text-foreground dark:bg-foreground/[0.12]' : 'text-secondary hover:bg-foreground/[0.04] hover:text-foreground'}`}>
                  {t(categoryLabels[value])}
                </button>
              ))}
            </div>
            <div className={`rounded-xl border transition-colors ${dragging ? 'border-dashed border-foreground/30 bg-foreground/[0.03]' : 'border-border bg-surface focus-within:border-foreground/25'}`}
              onDragOver={event => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={event => { event.preventDefault(); setDragging(false); addImages(Array.from(event.dataTransfer.files)); }}>
              <textarea aria-label={t('feedbackDescription')} value={content} maxLength={FEEDBACK_LIMITS.content} disabled={submitting}
                onChange={event => { changed(); setContent(event.target.value); }}
                onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); addImages(files); } }}
                placeholder={t(category === FeedbackCategory.AiReport ? 'feedbackReportPlaceholder' : 'feedbackPlaceholder')}
                className="block min-h-[148px] w-full resize-none rounded-t-xl bg-transparent px-3.5 pb-2 pt-3 text-[13px] leading-5 text-foreground placeholder:text-muted focus:outline-none disabled:opacity-60" />
              {images.length > 0 && <div className="flex flex-wrap gap-2 px-3.5 pb-2">
                {images.map(image => <div key={image.id} className="relative h-14 w-14 rounded-lg border border-border">
                  <button type="button" disabled={submitting} aria-label={`${t('feedbackPreviewImage')} ${image.file.name}`} title={t('feedbackPreviewImage')}
                    onClick={() => setPreviewImage(image)}
                    className="h-full w-full cursor-zoom-in overflow-hidden rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 disabled:cursor-default">
                    <img src={getFeedbackImagePreviewUrl(image.url)} alt={image.file.name} className="h-full w-full object-cover" />
                  </button>
                  <button type="button" disabled={submitting} aria-label={`${t('feedbackRemoveImage')} ${image.file.name}`}
                    onClick={() => { changed(); URL.revokeObjectURL(image.url); setImages(current => current.filter(item => item.id !== image.id)); }}
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground/80 p-0.5 text-background transition-colors hover:bg-foreground"><XMarkIcon className="h-3 w-3" /></button>
                </div>)}
              </div>}
              <div className="flex items-center justify-between gap-3 px-3 pb-3">
                <button type="button" disabled={submitting || images.length >= FEEDBACK_LIMITS.images} onClick={() => input.current?.click()}
                  className="flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40">
                  <PhotoIcon className="h-3.5 w-3.5" />{t('feedbackUploadImages')}
                  <span className="tabular-nums">({images.length}/{FEEDBACK_LIMITS.images})</span>
                </button>
                <span className="pr-0.5 text-xs tabular-nums text-muted">{content.length.toLocaleString()} / {FEEDBACK_LIMITS.content.toLocaleString()}</span>
              </div>
              <input ref={input} type="file" multiple accept={FEEDBACK_IMAGE_TYPES.join(',')} hidden aria-label={t('feedbackUploadImages')}
                onChange={event => { addImages(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
            </div>
            {error && <div role="alert" className="mt-3 text-xs text-red-500">{error}
              {needsLogin && <button type="button" onClick={() => void window.electron.auth.login()} className="ml-2 font-medium underline underline-offset-2">{t('login')}</button>}
            </div>}
            {confirmDiscard ? <div role="alert" className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
              <span className="mr-auto text-xs text-secondary">{t('feedbackDiscardNotice')}</span>
              <button type="button" onClick={() => setConfirmDiscard(false)} className="h-8 rounded-lg px-3 text-[13px] text-foreground transition-colors hover:bg-surface-raised">{t('feedbackKeepEditing')}</button>
              <button type="button" onClick={onClose} className="h-8 rounded-lg bg-red-500 px-3 text-[13px] font-medium text-white transition-colors hover:bg-red-600">{t('feedbackDiscard')}</button>
            </div> : <footer className="mt-5 flex items-end justify-between gap-4 border-t border-border pt-4">
              <div className="min-w-0 space-y-1.5">
                <label className="flex cursor-pointer items-center gap-2 text-[13px] text-foreground">
                  <input type="checkbox" checked={includeLogs} disabled={submitting} aria-describedby="feedback-logs-notice" onChange={event => { changed(); setIncludeLogs(event.target.checked); }}
                    className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-foreground" />
                  <span className="truncate">{t('feedbackIncludeLogs')}</span>
                </label>
                <p id="feedback-logs-notice" className="text-xs leading-5 text-secondary">
                  {t('feedbackLogsNotice')}{' '}
                  <button type="button" onClick={() => void window.electron.shell.openExternal(FEEDBACK_PRIVACY_URL)} className="text-primary hover:underline">{t('feedbackPrivacy')}</button>
                </p>
              </div>
              <button type="button" onClick={() => void submit()} disabled={submitting || !content.trim()}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-4 text-[13px] font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40">
                {submitting && <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />}{t(submitting ? 'feedbackSubmitting' : 'feedbackSubmit')}
              </button>
            </footer>}
          </>
        )}
      </section>
      <ImagePreviewModal image={previewImage && previewUrl ? { src: previewUrl, name: previewImage.file.name } : null} onClose={() => setPreviewImage(null)} />
    </Modal>
  );
}
