import { setTimeout as delay } from 'node:timers/promises';

import { buildManagedSessionKey } from '../../../shared/cowork/managedSessionKey';
import { TERMINAL_MEDIA_TASK_STATUSES } from '../../../shared/media/constants';
import { MediaPreferenceMode, type MediaSelection, MediaSelectionMode } from '../../../shared/media/defaultPolicy';
import type { MediaGenerationRequest, MediaGenerationResponse } from '../../mcp/mcpRuntime';
import { MediaGenerationAction, MediaGenerationTool } from '../../mediaGenerationPolicy';
import type { CoworkMediaAttachmentRef } from '../agentEngine/types';
import { compactMediaDetails } from '../mediaMetadataCompaction';
import type { HostToolProvider } from './dshHostBridgeWiring';
import type { DshHostToolDescriptor } from './dshHostManager';

const foregroundWaitMs = 60_000;
const savedImageWaitMs = 30 * 60_000;
const imageTool: DshHostToolDescriptor = {
  name: MediaGenerationTool.Image,
  description: 'Generate or edit images requested by the user through their LobsterAI image model. List available models with list. Check an existing task with status. Never resubmit a pending task. Only saved files are finished images.',
  timeoutMs: savedImageWaitMs + foregroundWaitMs,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: Object.values(MediaGenerationAction), description: 'Defaults to generate.' },
      prompt: { type: 'string', description: 'Describe the requested image or edit.' },
      model: { type: 'string', description: 'The selected image model ID.' },
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

export function buildDshImageTurnInstruction(selection?: MediaSelection, refs?: CoworkMediaAttachmentRef[]): string {
  if (!selection) return '';
  const model = selection.imageModelId ?? (selection.mode === MediaSelectionMode.Image ? selection.modelId : undefined);
  if (!model || selection.imagePreference === MediaPreferenceMode.Off
    || selection.mode === MediaSelectionMode.None || selection.mode === MediaSelectionMode.Video) {
    return 'LobsterAI image generation is unavailable for this turn. Do not use a different paid provider.';
  }
  const references = refs?.filter(ref => ref.mediaType === 'image' && (ref.localPath || ref.remoteUrl))
    .map(ref => ({ token: ref.token, source: ref.localPath || ref.remoteUrl }));
  const mapping = references?.length ? ` Reference images for this turn: ${JSON.stringify(references)}.` : '';
  return `For an explicit request to generate or edit an image, use ${MediaGenerationTool.Image} with the selected LobsterAI model ${JSON.stringify(model)}. A model preference alone does not authorize spending credits. Use one output unless the user requests more. Use status for an existing task. Do not submit a replacement while it is pending.${mapping}`;
}

export function createDshImageGenerationProvider(
  submit: (request: MediaGenerationRequest) => Promise<MediaGenerationResponse>,
): HostToolProvider {
  return {
    listDescriptors: () => [imageTool],
    async execute(tool, args, context) {
      if (tool !== imageTool.name || !context.coworkSessionId?.trim() || !context.callId?.trim()) {
        throw new Error('Image generation requires a bound LobsterAI conversation and tool call.');
      }
      const request: MediaGenerationRequest = {
        tool, args, signal: context.signal,
        context: { sessionKey: buildManagedSessionKey(context.coworkSessionId, context.agentId), toolCallId: context.callId },
      };
      const deadline = Date.now() + (args.waitForResult === true ? savedImageWaitMs : foregroundWaitMs);
      let polls = 0;
      while (true) {
        context.signal?.throwIfAborted();
        const result = await submit(request);
        const status = result.details?.status;
        if (args.action !== MediaGenerationAction.Status || result.isError || typeof status !== 'string'
          || TERMINAL_MEDIA_TASK_STATUSES.has(status) || Date.now() >= deadline) {
          return { ...result, details: compactMediaDetails(result.details) };
        }
        const interval = ++polls <= 12 ? 5_000 : 15_000;
        await delay(Math.min(interval, deadline - Date.now()), undefined, { signal: context.signal });
      }
    },
  };
}
