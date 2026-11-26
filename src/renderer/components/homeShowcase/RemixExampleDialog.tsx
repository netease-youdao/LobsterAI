import {
  ArrowRightIcon,
  ArrowUpTrayIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PaperClipIcon,
  SparklesIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  HOME_SHOWCASE_MAX_ATTACHMENTS,
  HOME_SHOWCASE_MAX_UPLOAD_BYTES,
  type HomeShowcaseExample,
  ShowcaseRemixMode,
} from '../../../shared/homeShowcase/constants';
import {
  buildShowcaseRemixPrompt,
  type ShowcasePreparedFile,
  type ShowcaseRemixOptions,
} from '../../services/homeShowcaseDraft';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import { ShowcasePreviewStage } from './ShowcasePreviewCard';

async function readUploadedFile(file: File): Promise<ShowcasePreparedFile> {
  if (!file.size || file.size > HOME_SHOWCASE_MAX_UPLOAD_BYTES) {
    throw new Error('File exceeds limit');
  }
  const base64Data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    base64Data,
    isImage: file.type.startsWith('image/'),
  };
}

interface RemixExampleDialogProps {
  example: HomeShowcaseExample;
  onClose: () => void;
  onApply: (example: HomeShowcaseExample, options: ShowcaseRemixOptions) => Promise<boolean>;
}

const RemixExampleDialog: React.FC<RemixExampleDialogProps> = ({ example, onClose, onApply }) => {
  const t = (key: string) => i18nService.t(key);
  const language = i18nService.getLanguage();
  const [customInput, setCustomInput] = useState('');
  const [selectedChoices, setSelectedChoices] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const group of example.optionGroups) {
      initial[group.id] = group.defaultChoiceId;
    }
    return initial;
  });
  const [userFiles, setUserFiles] = useState<ShowcasePreparedFile[]>([]);
  const [showFullPrompt, setShowFullPrompt] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState('');
  const [promptTouched, setPromptTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      mountedRef.current = false;
      previous?.focus();
    };
  }, []);

  const computedCustomPrompt = useMemo(
    () => buildShowcaseRemixPrompt(example, {
      mode: customInput.trim() || userFiles.length > 0 ? ShowcaseRemixMode.Custom : ShowcaseRemixMode.Demo,
      language,
      customInput,
      selectedChoices,
      userFiles,
    }),
    [customInput, example, language, selectedChoices, userFiles],
  );

  const displayedPrompt = promptTouched ? editedPrompt : computedCustomPrompt;
  const hasCustomContent = Boolean(customInput.trim() || userFiles.length > 0 || promptTouched);

  const handleFilesSelected = async (selected: File[]) => {
    if (!selected.length) return;
    if (userFiles.length + selected.length > HOME_SHOWCASE_MAX_ATTACHMENTS) {
      setError(t('homeShowcaseInvalidFile'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const prepared = await Promise.all(selected.map(readUploadedFile));
      if (mountedRef.current) {
        setUserFiles(prev => [...prev, ...prepared]);
      }
    } catch {
      if (mountedRef.current) setError(t('homeShowcaseInvalidFile'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleSubmit = async (mode: ShowcaseRemixMode) => {
    if (busy) return;
    if (mode === ShowcaseRemixMode.Custom && !hasCustomContent) {
      setError(t('homeShowcaseNeedCustomContent'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const applied = await onApply(example, {
        mode,
        language,
        customInput,
        selectedChoices,
        editedPrompt: mode === ShowcaseRemixMode.Custom && promptTouched ? editedPrompt : undefined,
        userFiles: mode === ShowcaseRemixMode.Custom ? userFiles : [],
        useSampleFiles: mode === ShowcaseRemixMode.Demo,
      });
      if (mountedRef.current) {
        if (applied) onClose();
        else setError(t('homeShowcaseDraftChanged'));
      }
    } catch (failure) {
      console.warn('[HomeShowcase] Failed to prepare remix draft:', failure);
      if (mountedRef.current) setError(t('homeShowcasePrepareFailed'));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const dismiss = () => {
    if (!busy) onClose();
  };

  return (
    <Modal
      onClose={dismiss}
      onEscape={dismiss}
      className="non-draggable w-[min(1040px,94vw)] overflow-hidden rounded-3xl border border-border bg-surface shadow-modal"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="home-showcase-dialog-title"
        data-home-showcase-dialog={example.id}
        className="flex h-[min(760px,90vh)] flex-col overflow-hidden"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-primary">{t('homeShowcaseGeneratedBadge')}</span>
              <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[11px] text-secondary">
                {example.badge[language]}
              </span>
            </div>
            <h2 id="home-showcase-dialog-title" className="mt-1 text-lg font-semibold text-foreground">
              {example.title[language]}
            </h2>
            <p className="mt-0.5 max-w-3xl text-xs leading-5 text-secondary">
              {example.description[language]}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            disabled={busy}
            onClick={dismiss}
            aria-label={t('close')}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-40"
          >
            <XMarkIcon aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[1.12fr_1fr] md:overflow-hidden scrollbar-hidden">
          <div className="min-h-[300px] min-w-0 bg-surface-raised/55 p-5 md:overflow-y-auto md:p-6 scrollbar-hidden">
            <ShowcasePreviewStage example={example} />
          </div>

          <div className="flex min-w-0 flex-col border-t border-border p-5 md:min-h-0 md:border-l md:border-t-0 md:p-6">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-0.5 scrollbar-hidden">
              <label className="block">
                <span className="text-xs font-semibold text-foreground">
                  {example.customSlot.label[language]}
                </span>
                {example.customSlot.multiline ? (
                  <textarea
                    rows={4}
                    value={customInput}
                    disabled={busy}
                    onChange={event => {
                      setCustomInput(event.target.value);
                      setError('');
                    }}
                    placeholder={example.customSlot.placeholder[language]}
                    className="mt-2 w-full resize-none rounded-xl border border-border-input bg-background px-3 py-2.5 text-sm leading-6 text-foreground placeholder:text-foreground/40 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15 disabled:opacity-50"
                  />
                ) : (
                  <input
                    type="text"
                    value={customInput}
                    disabled={busy}
                    onChange={event => {
                      setCustomInput(event.target.value);
                      setError('');
                    }}
                    placeholder={example.customSlot.placeholder[language]}
                    className="mt-2 h-11 w-full rounded-xl border border-border-input bg-background px-3 text-sm text-foreground placeholder:text-foreground/40 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15 disabled:opacity-50"
                  />
                )}
              </label>

              {(example.acceptsUpload || (example.sampleFiles && example.sampleFiles.length > 0)) && (
                <div className="rounded-xl border border-border/80 bg-surface-raised/45 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <PaperClipIcon aria-hidden="true" className="h-3.5 w-3.5 text-secondary" />
                      {userFiles.length > 0
                        ? t('homeShowcaseUsingOwnFiles')
                        : example.sampleFiles?.length
                          ? t('homeShowcaseSampleFileLabel')
                          : t('homeShowcaseAddOwnFile')}
                    </span>
                    {example.acceptsUpload && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => uploadRef.current?.click()}
                        className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:border-primary/40 hover:bg-primary-muted/60 disabled:opacity-50"
                      >
                        <ArrowUpTrayIcon aria-hidden="true" className="h-3.5 w-3.5" />
                        {example.sampleFiles?.length ? t('homeShowcaseUploadOwnFile') : t('homeShowcaseAddOwnFile')}
                      </button>
                    )}
                    <input
                      ref={uploadRef}
                      type="file"
                      multiple
                      accept={example.uploadAccept}
                      className="hidden"
                      onChange={event => {
                        void handleFilesSelected(Array.from(event.target.files ?? []));
                        event.target.value = '';
                      }}
                    />
                  </div>

                  {userFiles.length > 0 ? (
                    <div className="mt-2 space-y-1.5">
                      {userFiles.map((file, idx) => (
                        <div
                          key={`${file.name}-${idx}`}
                          className="flex items-center justify-between gap-2 rounded-lg bg-surface px-2.5 py-1.5 text-xs text-foreground"
                        >
                          <span className="min-w-0 truncate">{file.name}</span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setUserFiles(prev => prev.filter((_, i) => i !== idx))}
                            aria-label={t('close')}
                            className="rounded p-0.5 text-secondary hover:bg-destructive/10 hover:text-destructive"
                          >
                            <XMarkIcon className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : example.sampleFiles && example.sampleFiles.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {example.sampleFiles.map(sample => (
                        <span
                          key={sample.name}
                          className="inline-flex items-center rounded-md border border-border/70 bg-surface px-2 py-0.5 text-[11px] text-secondary"
                        >
                          {sample.name}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {example.uploadHint && (
                    <p className="mt-1.5 text-[11px] leading-4 text-secondary">
                      {example.uploadHint[language]}
                    </p>
                  )}
                </div>
              )}

              {example.optionGroups.length > 0 && (
                <div className="space-y-3">
                  {example.optionGroups.map(group => {
                    const activeId = selectedChoices[group.id] ?? group.defaultChoiceId;
                    return (
                      <div key={group.id}>
                        <p className="mb-1.5 text-xs font-medium text-secondary">
                          {group.label[language]}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {group.choices.map(choice => {
                            const selected = activeId === choice.id;
                            return (
                              <button
                                key={choice.id}
                                type="button"
                                disabled={busy}
                                aria-pressed={selected}
                                onClick={() => setSelectedChoices(prev => ({ ...prev, [group.id]: choice.id }))}
                                className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                                  selected
                                    ? 'border-primary/45 bg-primary-muted/75 text-primary'
                                    : 'border-border/80 bg-background text-foreground/80 hover:border-border hover:bg-surface-raised'
                                }`}
                              >
                                {choice.label[language]}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div>
                <button
                  type="button"
                  onClick={() => {
                    if (!showFullPrompt && !promptTouched) {
                      setEditedPrompt(computedCustomPrompt);
                    }
                    setShowFullPrompt(prev => !prev);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-secondary transition-colors hover:text-foreground"
                >
                  {showFullPrompt ? t('homeShowcaseHideFullPrompt') : t('homeShowcaseEditFullPrompt')}
                  {showFullPrompt
                    ? <ChevronUpIcon aria-hidden="true" className="h-3.5 w-3.5" />
                    : <ChevronDownIcon aria-hidden="true" className="h-3.5 w-3.5" />}
                </button>
                {showFullPrompt && (
                  <textarea
                    rows={5}
                    value={displayedPrompt}
                    disabled={busy}
                    onChange={event => {
                      setEditedPrompt(event.target.value);
                      setPromptTouched(true);
                    }}
                    className="mt-2 w-full resize-none rounded-xl border border-border-input bg-background px-3 py-2 text-xs leading-5 text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
                  />
                )}
              </div>
            </div>

            <div className="mt-4 shrink-0 space-y-2 border-t border-border/70 pt-4">
              {error && (
                <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {hasCustomContent ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleSubmit(ShowcaseRemixMode.Custom)}
                      className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-action px-4 py-2.5 text-sm font-medium text-action-foreground transition-colors hover:bg-action-hover disabled:opacity-50"
                    >
                      {busy ? t('homeShowcaseCtaPreparing') : t('homeShowcaseCtaCustom')}
                      <ArrowRightIcon aria-hidden="true" className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleSubmit(ShowcaseRemixMode.Demo)}
                      className="flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
                    >
                      <SparklesIcon aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                      {t('homeShowcaseCtaDemo')}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleSubmit(ShowcaseRemixMode.Demo)}
                      className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-action px-4 py-2.5 text-sm font-medium text-action-foreground transition-colors hover:bg-action-hover disabled:opacity-50"
                    >
                      <SparklesIcon aria-hidden="true" className="h-4 w-4" />
                      {busy ? t('homeShowcaseCtaPreparing') : t('homeShowcaseCtaDemo')}
                      <ArrowRightIcon aria-hidden="true" className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleSubmit(ShowcaseRemixMode.Custom)}
                      className="flex min-h-10 items-center justify-center rounded-xl border border-border bg-surface px-3.5 py-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
                    >
                      {t('homeShowcaseCtaCustom')}
                    </button>
                  </>
                )}
              </div>
              <p className="text-[11px] leading-4 text-secondary">
                {t('homeShowcaseDraftHint')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default RemixExampleDialog;
