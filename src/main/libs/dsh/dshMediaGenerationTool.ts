import { setTimeout as delay } from 'node:timers/promises';

import { UsageStage } from '../../../shared/analytics/usage';
import { buildManagedSessionKey } from '../../../shared/cowork/managedSessionKey';
import { ImageProcessingOperation, LOBSTERAI_WATERMARK_TARGET, MediaDeliveryStatus, MediaTaskStatus, REMOVE_WATERMARK_OPERATION, TERMINAL_MEDIA_TASK_STATUSES } from '../../../shared/media/constants';
import { MediaPreferenceMode, type MediaSelection, MediaSelectionMode } from '../../../shared/media/defaultPolicy';
import { SkinToolName, SkinWorkflowKind } from '../../../shared/skin/constants';
import { t } from '../../i18n';
import type { MediaGenerationRequest, MediaGenerationResponse } from '../../mcp/mcpRuntime';
import { MediaGenerationAction, MediaGenerationTool } from '../../mediaGenerationPolicy';
import { buildSkinPackInstruction } from '../agentEngine/mediaGenerationTurnInstruction';
import type { CoworkMediaAttachmentRef } from '../agentEngine/types';
import { compactMediaDetails } from '../mediaMetadataCompaction';
import type { HostToolProvider } from './dshHostBridgeWiring';
import type { DshHostToolDescriptor } from './dshHostManager';
import { dshSkinTool } from './dshSkinTool';

const foregroundWaitMs = 60_000;
const savedImageWaitMs = 30 * 60_000;
const savedVideoWaitMs = 10 * 60 * 60_000;
const imageActions = [MediaGenerationAction.Generate, MediaGenerationAction.List, MediaGenerationAction.Status];
const videoActions = [...imageActions, MediaGenerationAction.Cancel];
const videoPollSchedule = [
  { through: 6, intervalMs: 10_000 },
  { through: 24, intervalMs: 30_000 },
  { through: 34, intervalMs: 120_000 },
];
const imageTool: DshHostToolDescriptor = {
  name: MediaGenerationTool.Image,
  description: 'Generate or edit images requested by the user through their LobsterAI image model. List available models with list. Check an existing task with status. Never resubmit a pending task. Only saved files are finished images.',
  timeoutMs: savedImageWaitMs + foregroundWaitMs,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: imageActions, description: 'Defaults to generate.' },
      prompt: { type: 'string', description: 'Describe the requested image or edit.' },
      model: { type: 'string', description: 'The selected image model ID.' },
      imageOperation: { type: 'string', enum: [...Object.values(ImageProcessingOperation), REMOVE_WATERMARK_OPERATION], description: 'Process one existing image. Pick one operation. For erase, identify the target in the prompt. Matting returns a transparent PNG. remove_watermark is the legacy LobsterAI watermark edit.' },
      eraseTarget: { type: 'string', enum: [LOBSTERAI_WATERMARK_TARGET], description: 'With erase only, set this when the user specifically asks to remove the LobsterAI watermark.' },
      image: { type: 'string', description: 'Reference image file path or URL.' },
      images: { type: 'array', items: { type: 'string' }, description: 'Reference image file paths or URLs.' },
      size: { type: 'string' },
      aspectRatio: { type: 'string' },
      resolution: { type: 'string' },
      imageSize: { type: 'string' },
      n: { type: 'integer', description: 'Number of outputs, defaults to one. Alias of count.' },
      count: { type: 'integer', description: 'Number of outputs, defaults to one.' },
      quality: { type: 'string' },
      outputFormat: { type: 'string' },
      output_format: { type: 'string', description: 'Alias of outputFormat.' },
      temperature: { type: 'number' },
      layerDecomposition: { type: 'boolean', description: 'Split one reference image into layers. Each output is billed.' },
      layerDecompositionOptions: {
        type: 'object', properties: { max_images: { type: 'integer' }, text_recognition: { type: 'boolean' } },
      },
      background: { type: 'string' },
      filename: { type: 'string' },
      taskId: { type: 'string', description: 'Existing task ID for status.' },
      waitForResult: { type: 'boolean', description: 'For status, wait for the saved image if the next step needs its file.' },
      providerOptions: { type: 'object', additionalProperties: true },
    },
  },
};

const videoTool: DshHostToolDescriptor = {
  name: MediaGenerationTool.Video,
  description: 'Generate a video with the selected LobsterAI model. The desktop asks the user to confirm the quote. If it expires or the user declines, end this turn and wait for a new user request. Check status only with a returned task ID. Cancel a queued task only at the user’s request.',
  timeoutMs: savedVideoWaitMs + foregroundWaitMs,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: videoActions, description: 'Defaults to generate.' },
      prompt: { type: 'string' },
      model: { type: 'string', description: 'Selected video model ID.' },
      image: { type: 'string', description: 'Reference image path or URL.' },
      images: { type: 'array', items: { type: 'string' } },
      imageRoles: { type: 'array', items: { type: 'string' }, description: 'Roles in images order: first_frame, last_frame or reference_image.' },
      firstFrame: { type: 'string' },
      lastFrame: { type: 'string' },
      referenceImages: { type: 'array', items: { type: 'string' } },
      video: { type: 'string', description: 'Reference video path or URL.' },
      videos: { type: 'array', items: { type: 'string' } },
      videoRoles: { type: 'array', items: { type: 'string' } },
      media: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Model-specific media references, including reference audio.' },
      aspectRatio: { type: 'string' },
      resolution: { type: 'string' },
      durationSeconds: { type: 'number', minimum: -1, maximum: 60 },
      audio: { type: 'boolean' },
      watermark: { type: 'boolean' },
      seed: { type: 'number' },
      returnLastFrame: { type: 'boolean' },
      cameraFixed: { type: 'boolean' },
      filename: { type: 'string' },
      taskId: { type: 'string', description: 'Existing task ID for status or cancel.' },
      waitForResult: { type: 'boolean', description: 'Wait for the saved video when subsequent work requires it.' },
      providerOptions: { type: 'object', additionalProperties: true },
    },
  },
};

export function buildDshMediaTurnInstruction(
  selection?: MediaSelection,
  refs?: CoworkMediaAttachmentRef[],
  workflowKind?: SkinWorkflowKind,
): string {
  if (workflowKind === SkinWorkflowKind.SkinPack) return buildSkinPackInstruction(selection, refs);
  if (!selection) return '';
  const image = selection.imageModelId ?? (selection.mode === MediaSelectionMode.Image ? selection.modelId : undefined);
  const video = selection.videoModelId ?? (selection.mode === MediaSelectionMode.Video ? selection.modelId : undefined);
  const useImage = image && selection.imagePreference !== MediaPreferenceMode.Off
    && (selection.mode === MediaSelectionMode.Image || selection.mode === MediaSelectionMode.Auto);
  const useVideo = video && selection.videoPreference !== MediaPreferenceMode.Off
    && (selection.mode === MediaSelectionMode.Video || selection.mode === MediaSelectionMode.Auto);
  const instructions = [
    useImage ? `For an explicit request to generate or edit an image, use ${MediaGenerationTool.Image} with the selected LobsterAI model ${JSON.stringify(image)}.`
      : 'LobsterAI image generation is unavailable for this turn.',
    useVideo ? `For an explicit video generation request, use ${MediaGenerationTool.Video} with the selected LobsterAI model ${JSON.stringify(video)}. List its capabilities before generation. The desktop collects confirmation and verifies the saved file. Once status returns its file link, reply with that exact link. Use shell or file tools only for further work the user explicitly requests.`
      : 'LobsterAI video generation is unavailable for this turn.',
    'A preference alone does not authorize spending credits. Do not use another paid provider. Generate one output unless requested otherwise. Use status for an existing task and never resubmit a pending task.',
  ];
  const references = refs?.filter(ref => (useVideo || (useImage && ref.mediaType === 'image')) && (ref.localPath || ref.remoteUrl))
    .map(ref => ({ token: ref.token, mediaType: ref.mediaType, role: ref.role, source: ref.localPath || ref.remoteUrl }));
  if (references?.length) instructions.push(`Use the mapped paths or URLs for media arguments: ${JSON.stringify(references)}.`);
  return instructions.join(' ');
}

export function createDshMediaGenerationProvider(
  submit: (request: MediaGenerationRequest) => Promise<MediaGenerationResponse>,
  getTurnSignal?: (sessionId: string) => AbortSignal | undefined,
): HostToolProvider {
  const videoQuotes = new WeakMap<AbortSignal, MediaGenerationResponse>();
  return {
    listDescriptors: () => [imageTool, videoTool, dshSkinTool],
    async execute(tool, args, context) {
      if ((tool !== MediaGenerationTool.Image && tool !== MediaGenerationTool.Video && tool !== SkinToolName.Manage)
        || !context.coworkSessionId?.trim() || !context.callId?.trim()) {
        throw new Error('Media generation requires a bound LobsterAI conversation and tool call.');
      }
      const request: MediaGenerationRequest = {
        tool, args, signal: context.signal,
        context: { sessionKey: buildManagedSessionKey(context.coworkSessionId, context.agentId), toolCallId: context.callId },
      };
      if (tool === SkinToolName.Manage) {
        context.signal?.throwIfAborted();
        return submit(request);
      }
      const video = tool === MediaGenerationTool.Video;
      const actions: readonly string[] = video ? videoActions : imageActions;
      if (args.action !== undefined && (typeof args.action !== 'string' || !actions.includes(args.action))) {
        throw new Error('Unsupported media generation action.');
      }
      const generatingVideo = video && (args.action ?? MediaGenerationAction.Generate) === MediaGenerationAction.Generate;
      const turn = generatingVideo ? getTurnSignal?.(context.coworkSessionId) : undefined;
      if (generatingVideo && getTurnSignal && !turn) throw new Error('Video generation requires an active chat turn.');
      if (turn) {
        turn.throwIfAborted();
        context.signal?.throwIfAborted();
        const previous = videoQuotes.get(turn);
        if (previous) return previous;
        videoQuotes.set(turn, {
          isError: true, content: [{ type: 'text', text: t('mediaVideoQuotePending') }],
        });
        try {
          const result = await submit(request);
          if (result.details?.failureStage === UsageStage.Confirmation) {
            videoQuotes.set(turn, result);
            return result;
          }
          videoQuotes.delete(turn);
          return { ...result, details: compactMediaDetails(result.details) };
        } catch (error) {
          videoQuotes.set(turn, { isError: true, content: [{ type: 'text', text: t('mediaVideoQuoteUnknown') }] });
          throw error;
        }
      }
      const savedWaitMs = video ? savedVideoWaitMs : savedImageWaitMs;
      const deadline = Date.now() + (args.waitForResult === true ? savedWaitMs : foregroundWaitMs);
      let polls = 0;
      while (true) {
        context.signal?.throwIfAborted();
        const result = await submit(request);
        const status = result.details?.status;
        if (video && args.action === MediaGenerationAction.Status && !result.isError
          && status === MediaTaskStatus.Succeeded && result.details?.deliveryStatus === MediaDeliveryStatus.Saved) {
          return {
            ...result, details: compactMediaDetails(result.details),
            content: [...result.content, { type: 'text', text: 'The desktop has saved this video. For a generation-only request, finish by sharing the file link above directly.' }],
          };
        }
        if (args.action !== MediaGenerationAction.Status || result.isError || typeof status !== 'string'
          || TERMINAL_MEDIA_TASK_STATUSES.has(status) || Date.now() >= deadline) {
          return { ...result, details: compactMediaDetails(result.details) };
        }
        polls += 1;
        const interval = video
          ? videoPollSchedule.find(step => polls <= step.through)?.intervalMs ?? 600_000
          : (polls <= 12 ? 5_000 : 15_000);
        await delay(Math.min(interval, deadline - Date.now()), undefined, { signal: context.signal });
      }
    },
  };
}
