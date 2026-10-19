import { type MediaSelection, MediaSelectionMode } from '../shared/media/defaultPolicy';
export { MediaSelectionMode };

export const MediaGenerationTool = {
  Image: 'lobsterai_image_generate',
  Video: 'lobsterai_video_generate',
} as const;
export type MediaGenerationTool = typeof MediaGenerationTool[keyof typeof MediaGenerationTool];

export const MediaGenerationAction = {
  Generate: 'generate',
} as const;
export type MediaGenerationAction = typeof MediaGenerationAction[keyof typeof MediaGenerationAction];

export const MediaGenerationGateReason = {
  MediaNotEnabled: 'MEDIA_NOT_ENABLED',
  WrongMediaType: 'WRONG_MEDIA_TYPE',
} as const;
export type MediaGenerationGateReason = typeof MediaGenerationGateReason[keyof typeof MediaGenerationGateReason];

export type MediaSelectionState = MediaSelection;

export type MediaGenerationGateResult =
  | { allowed: true }
  | { allowed: false; reason: MediaGenerationGateReason; message: string };

export const resolveMediaGenerationGate = (input: {
  action: string;
  tool: string;
  selection?: MediaSelectionState;
}): MediaGenerationGateResult => {
  if (input.action !== MediaGenerationAction.Generate) {
    return { allowed: true };
  }

  if (!input.selection || input.selection.mode === MediaSelectionMode.None) {
    return {
      allowed: false,
      reason: MediaGenerationGateReason.MediaNotEnabled,
      message: 'Tool unavailable: This media generation tool is not available in this session. No media generation model has been selected by the user. Do not retry.',
    };
  }

  if (input.selection?.mode === MediaSelectionMode.Image && input.tool === MediaGenerationTool.Video) {
    return {
      allowed: false,
      reason: MediaGenerationGateReason.WrongMediaType,
      message: 'Video generation is not available. The user selected an image generation model for this turn.',
    };
  }

  if (input.selection?.mode === MediaSelectionMode.Video && input.tool === MediaGenerationTool.Image) {
    return {
      allowed: false,
      reason: MediaGenerationGateReason.WrongMediaType,
      message: 'Image generation is not available. The user selected a video generation model for this turn.',
    };
  }

  return { allowed: true };
};
