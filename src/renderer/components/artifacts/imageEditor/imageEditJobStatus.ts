import { MediaDeliveryStatus, MediaTaskStatus } from '../../../../shared/media/constants';
import type { CoworkMessage } from '../../../types/cowork';
import { isMediaTaskSettled, mediaTaskLabelKey } from '../../cowork/MediaTaskCard';
import { isMediaGenerationToolName, mergeMediaTaskDetails } from '../../cowork/mediaTaskPresentation';

export const ImageEditJobPhase = { Queued: 'queued', Preparing: 'preparing', Generating: 'generating', Failed: 'failed' } as const;
export type ImageEditJobPhase = typeof ImageEditJobPhase[keyof typeof ImageEditJobPhase];
export interface ImageEditJobStatus { phase: ImageEditJobPhase; labelKey: string; reason?: string }

const REASON_MAX_LENGTH = 240;
const reasonOf = (value: unknown): string | undefined => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, REASON_MAX_LENGTH) : undefined;
};

/**
 * Reads an edit's progress from the conversation: the user message that carried the request and the media calls
 * of the turn it started. The new version itself arrives separately, through the image editing bridge.
 */
export function imageEditJobStatus({ requestId, messages, queued, running }: {
  requestId: string; messages: readonly CoworkMessage[]; queued: boolean; running: boolean;
}): ImageEditJobStatus {
  if (queued) return { phase: ImageEditJobPhase.Queued, labelKey: 'imageEditQueued' };
  let start = messages.length - 1;
  while (start >= 0 && !(messages[start].type === 'user' && messages[start].metadata?.imageEdits?.some(edit => edit.requestId === requestId))) start--;
  if (start < 0) return { phase: ImageEditJobPhase.Preparing, labelKey: 'imageEditPreparing' };

  const mediaCalls = new Set<string>();
  let details: Record<string, unknown> | undefined;
  let toolError: string | undefined;
  let turnError: string | undefined;
  let replied = false;
  for (const message of messages.slice(start + 1)) {
    if (message.type === 'user') break;
    replied = true;
    const metadata = message.metadata ?? {};
    const toolUseId = typeof metadata.toolUseId === 'string' ? metadata.toolUseId : '';
    if (message.type === 'tool_use' && isMediaGenerationToolName(String(metadata.toolName ?? ''))) {
      if (toolUseId) mediaCalls.add(toolUseId);
      details = mergeMediaTaskDetails(details ?? {}, (metadata.mediaStatusDetails as Record<string, unknown> | undefined) ?? {});
    } else if (message.type === 'tool_result' && mediaCalls.has(toolUseId)) {
      const result = (metadata.toolResultDetails as Record<string, unknown> | undefined) ?? {};
      details = mergeMediaTaskDetails(details ?? {}, result);
      // A call rejected before a task exists (e.g. an unsupported model) only explains itself in its text.
      toolError = metadata.isError && !result.status ? reasonOf(message.content) ?? reasonOf(metadata.error) ?? '' : undefined;
    } else if (message.type !== 'tool_use' && message.type !== 'tool_result') {
      turnError = reasonOf(metadata.error) ?? turnError;
    }
  }

  if (toolError !== undefined) return { phase: ImageEditJobPhase.Failed, labelKey: 'mediaTaskFailed', reason: toolError || undefined };
  if (details) {
    const imageDetails = { mediaType: 'image', ...details };
    if (!isMediaTaskSettled(imageDetails)) return { phase: ImageEditJobPhase.Generating, labelKey: mediaTaskLabelKey(imageDetails) };
    // Saved by the task but not yet registered as a version: the bridge reports it in a moment.
    if (details.status === MediaTaskStatus.Succeeded && details.deliveryStatus !== MediaDeliveryStatus.Failed) {
      return { phase: ImageEditJobPhase.Generating, labelKey: 'mediaTaskFetching' };
    }
    return { phase: ImageEditJobPhase.Failed, labelKey: mediaTaskLabelKey(imageDetails) };
  }
  // The turn ended without calling the media tool at all; the reply explains why.
  if (replied && !running) return { phase: ImageEditJobPhase.Failed, labelKey: 'imageEditNoResult', reason: turnError };
  return { phase: ImageEditJobPhase.Preparing, labelKey: 'imageEditPreparing' };
}
