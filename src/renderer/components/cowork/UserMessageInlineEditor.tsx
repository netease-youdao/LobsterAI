import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { isBrowserAnnotationTransportImage } from '../../../shared/cowork/imageAttachments';
import { extractPastedTextBlocks, formatPastedTextBlock, getPastedTextPreview } from '../../../shared/cowork/pastedText';
import { configService } from '../../services/config';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';
import { extractUserMessageFileAttachments } from '../../utils/userMessageFileAttachments';
import { COWORK_DETAIL_CONTENT_CLASS, COWORK_DETAIL_GUTTER_CLASS } from './messageDisplayUtils';
import { matchesSendShortcut } from './sendShortcut';

interface Props {
  message: CoworkMessage;
  initialPrompt?: string;
  initialRemovedImageIndexes?: number[];
  busy: boolean;
  disabled?: boolean;
  recoveryPending?: boolean;
  error?: string;
  onCancel: () => void;
  onSubmit: (prompt: string, removedImageIndexes: number[]) => void;
}

/** Splits a stored prompt into the typed text and the cards the composer appended to it. */
function parseEditableContent(content: string) {
  const { text: withFileLines, blocks } = extractPastedTextBlocks(content);
  const { text, attachments: files } = extractUserMessageFileAttachments(withFileLines);
  return { text, blocks, files };
}

export default function UserMessageInlineEditor({ message, initialPrompt, initialRemovedImageIndexes, busy, disabled, recoveryPending, error, onCancel, onSubmit }: Props) {
  const [initial] = useState(() => parseEditableContent(initialPrompt ?? message.content));
  const [text, setText] = useState(initial.text);
  const [blocks, setBlocks] = useState(initial.blocks);
  const [files, setFiles] = useState(initial.files);
  const [removed, setRemoved] = useState<number[]>(initialRemovedImageIndexes ?? []);
  const input = useRef<HTMLTextAreaElement>(null);
  const noticeId = useId();
  const images = message.metadata?.imageAttachmentPreviews?.length
    ? message.metadata.imageAttachmentPreviews : message.metadata?.imageAttachments ?? [];
  const locked = busy || disabled;
  const editContext = message.metadata?.editContext as { mediaReferences?: unknown[] } | undefined;
  const canRemoveImages = !message.metadata?.browserAnnotations?.length && !editContext?.mediaReferences?.length;
  const hasContext = Boolean(message.metadata?.skillIds?.length || message.metadata?.kitIds?.length
    || message.metadata?.selectedTextSnippets?.length || message.metadata?.browserAnnotations?.length);
  const canSubmit = !locked && Boolean(text.trim() || blocks.length || files.length
    || images.some((_, index) => !removed.includes(index)) || message.metadata?.browserAnnotations?.length);
  const submit = () => {
    if (!canSubmit) return;
    // Same layout the composer produces: typed text, pasted cards, then attachment lines.
    const fileLines = files.map(file =>
      `${i18nService.t(file.isDirectory ? 'inputFolderLabel' : 'inputFileLabel')}: ${file.path}`).join('\n');
    onSubmit([text, ...blocks.map(formatPastedTextBlock), fileLines].filter(Boolean).join('\n\n'), removed);
  };
  useEffect(() => { input.current?.focus(); }, []);
  useLayoutEffect(() => {
    const textarea = input.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    resize();
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      resize();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className={`w-full py-2 ${COWORK_DETAIL_GUTTER_CLASS}`} data-message-inline-editor>
      <div className={`${COWORK_DETAIL_CONTENT_CLASS} rounded-3xl bg-chat-user p-4 text-chat-user-foreground`}>
        <textarea
          ref={input}
          aria-label={i18nService.t('coworkEditLabel')}
          rows={1}
          value={text}
          disabled={locked}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === 'Escape') {
              event.preventDefault(); event.stopPropagation();
              if (!busy && !recoveryPending) onCancel();
            } else if (matchesSendShortcut(configService.getConfig().shortcuts?.sendMessage ?? 'Enter', event, navigator.platform.includes('Mac'))) {
              event.preventDefault(); event.stopPropagation(); submit();
            }
          }}
          className="text-markdown-body-compact block max-h-[min(60vh,30rem)] min-h-6 w-full resize-none overflow-y-auto bg-transparent text-foreground/90 outline-none disabled:opacity-60"
        />
        {(images.length > 0 || blocks.length > 0 || files.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {images.map((image, index) => removed.includes(index) || isBrowserAnnotationTransportImage(image) ? null : (
              <div key={index} className="flex max-w-full items-center gap-2 rounded-lg border border-border px-2 py-1 text-xs">
                <img src={`data:${image.mimeType};base64,${image.base64Data}`} alt="" className="h-8 w-8 rounded object-cover" />
                <span className="max-w-40 truncate">{image.name}</span>
                {canRemoveImages && (
                  <button type="button" disabled={locked} title={i18nService.t('coworkEditRemoveAttachment')}
                    aria-label={`${i18nService.t('coworkEditRemoveAttachment')}: ${image.name}`}
                    onClick={() => setRemoved(previous => [...previous, index])} className="rounded px-1 hover:bg-background">×</button>
                )}
              </div>
            ))}
            {blocks.map(block => (
              <div key={block.id} title={block.text} className="flex items-center gap-2 rounded-lg border border-border px-2 py-2 text-xs">
                <span className="max-w-52 truncate">{getPastedTextPreview(block.text)}</span>
                <button type="button" disabled={locked} aria-label={i18nService.t('coworkEditRemoveAttachment')}
                  onClick={() => setBlocks(previous => previous.filter(item => item.id !== block.id))} className="rounded px-1 hover:bg-background">×</button>
              </div>
            ))}
            {files.map(file => (
              <div key={file.path} title={file.path} className="flex max-w-full items-center gap-2 rounded-lg border border-border px-2 py-2 text-xs">
                <span className="max-w-52 truncate">{file.name}</span>
                <button type="button" disabled={locked} title={i18nService.t('coworkEditRemoveAttachment')}
                  aria-label={`${i18nService.t('coworkEditRemoveAttachment')}: ${file.name}`}
                  onClick={() => setFiles(previous => previous.filter(item => item.path !== file.path))} className="rounded px-1 hover:bg-background">×</button>
              </div>
            ))}
          </div>
        )}
        {hasContext && <p className="mt-2 text-xs text-muted">{i18nService.t('coworkEditContextKept')}</p>}
        <p id={noticeId} className="sr-only">{i18nService.t('coworkEditNotice')}</p>
        {error && <p role="alert" className="mt-2 text-sm text-red-500">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={busy || recoveryPending} onClick={onCancel}
            className="h-8 rounded-xl border border-border/60 bg-background px-3 text-sm font-medium transition-colors hover:bg-background/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40 disabled:opacity-50">
            {i18nService.t('coworkEditCancel')}
          </button>
          <button type="button" disabled={!canSubmit} onClick={submit}
            title={i18nService.t('coworkEditNotice')} aria-describedby={noticeId}
            className="h-8 rounded-xl bg-foreground px-3 text-sm font-medium text-background transition-colors hover:bg-foreground/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40 disabled:opacity-50">
            {i18nService.t(busy ? 'coworkEditSending' : 'coworkEditSave')}
          </button>
        </div>
      </div>
    </div>
  );
}
