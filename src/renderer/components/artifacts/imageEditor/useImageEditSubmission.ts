import { useEffect, useRef } from 'react';

import { type CoworkImageAttachmentPayload } from '../../../../shared/cowork/imageAttachments';
import { CoworkSteerStatus } from '../../../../shared/cowork/steer';
import { hasImageEditModel } from '../../../../shared/imageEditing/availability';
import { ImageEditorEvent } from '../../../../shared/imageEditing/types';
import { type MediaSelection } from '../../../../shared/media/defaultPolicy';
import { prepareCoworkPromptPayload } from '../../../services/coworkPromptPayload';
import { i18nService } from '../../../services/i18n';
import { imageEditAttachment, type ImageEditSubmitEvent } from '../../../services/imageEditing';
import { store } from '../../../store';
import { addPendingSteer } from '../../../store/slices/coworkSlice';
import { CoworkCollaborationMode } from '../../../types/cowork';
import type { MediaAttachmentRef } from '../../../types/mediaGeneration';

interface Options {
  sessionId?: string;
  blocked: boolean;
  isStreaming: boolean;
  modelSupportsImage: boolean;
  ownerAccountKey: string | null;
  accountGeneration: number;
  mediaSelection?: MediaSelection;
  queueLimit: number;
  onSubmit: (prompt: string, skillPrompt?: string, images?: CoworkImageAttachmentPayload[], refs?: MediaAttachmentRef[],
    snippets?: never[], annotations?: never[], mode?: CoworkCollaborationMode) => Promise<unknown> | unknown;
}

/** Toolbar commands use the same submit callback/queue without consuming the composer draft. */
export function useImageEditSubmission(options: Options): void {
  const current = useRef(options);
  current.current = options;
  const submitting = useRef(false);
  useEffect(() => {
    const listener = (event: Event) => {
      const command = event as CustomEvent<ImageEditSubmitEvent>;
      const context = current.current;
      if (command.detail.request.source.sessionId !== context.sessionId || event.defaultPrevented) return;
      event.preventDefault();
      const run = async () => {
        if (context.blocked || submitting.current || !context.sessionId) throw new Error(i18nService.t('imageEditBusy'));
        const selection = context.mediaSelection;
        if (!hasImageEditModel(selection)) {
          throw new Error(i18nService.t('imageEditSelectModel'));
        }
        submitting.current = true;
        const attachment = imageEditAttachment(command.detail.request);
        if (context.isStreaming) {
          const pending = store.getState().cowork.pendingSteers[context.sessionId] ?? [];
          if (pending.length >= context.queueLimit) throw new Error(i18nService.t('coworkSteerQueueFull'));
          const now = Date.now();
          store.dispatch(addPendingSteer({ id: crypto.randomUUID(), sessionId: context.sessionId,
            ownerAccountKey: context.ownerAccountKey, accountGeneration: context.accountGeneration,
            text: '', attachments: [attachment], modelSupportsImage: context.modelSupportsImage,
            mediaSelection: selection, status: CoworkSteerStatus.Pending, createdAt: now, updatedAt: now }));
          return true;
        }
        const result = await prepareCoworkPromptPayload({ basePrompt: '', attachments: [attachment], selectedTextSnippets: [],
          modelSupportsImage: context.modelSupportsImage, readFileAsDataUrl: path => window.electron.dialog.readFileAsDataUrl(path),
          fileLabel: i18nService.t('coworkAttachmentFile'), folderLabel: i18nService.t('coworkAttachmentFolder') });
        if (!result.success) throw new Error(i18nService.t('imageEditFailed'));
        const payload = result.payload;
        return (await context.onSubmit(payload.finalPrompt, undefined, payload.imageAttachments, payload.mediaReferences,
          undefined, undefined, CoworkCollaborationMode.Default)) !== false;
      };
      void run().then(accepted => command.detail.complete(accepted)).catch(error => {
        command.detail.complete(false, error instanceof Error ? error.message : undefined);
      }).finally(() => { submitting.current = false; });
    };
    window.addEventListener(ImageEditorEvent.Submit, listener);
    return () => window.removeEventListener(ImageEditorEvent.Submit, listener);
  }, []);
}
