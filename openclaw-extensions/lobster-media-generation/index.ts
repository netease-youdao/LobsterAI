import { Type } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

import { isLobsterAiDesktopSessionKey } from './sessionKey';
import {
  type MediaStatusPollPolicy,
  type MediaStatusResponse,
  type MediaStatusType,
  type MediaStatusUpdate,
  pollMediaStatus,
} from './statusPolling';

type PluginConfig = {
  callbackUrl: string;
  secret: string;
  requestTimeoutMs: number;
};

type MediaToolRequest = {
  tool: string;
  args: Record<string, unknown>;
  context: {
    sessionKey: string;
    toolCallId: string;
  };
};

type MediaToolResponse = MediaStatusResponse;

const DEFAULT_TIMEOUT_MS = 150_000;

const STATUS_REQUEST_TIMEOUT_MS = 150_000;

const IMAGE_STATUS_POLL_POLICY: MediaStatusPollPolicy = {
  timeoutMs: 30 * 60_000,
  fastIntervalMs: 5_000,
  slowIntervalMs: 15_000,
  mediumIntervalMs: 30_000,
  idleIntervalMs: 60_000,
  fastPollCount: 12,
  slowPollCount: 12,
  mediumPollCount: 20,
};

const VIDEO_STATUS_POLL_POLICY: MediaStatusPollPolicy = {
  timeoutMs: 36_000_000,
  fastIntervalMs: 10_000,
  slowIntervalMs: 30_000,
  mediumIntervalMs: 120_000,
  idleIntervalMs: 600_000,
  fastPollCount: 6,
  slowPollCount: 18,
  mediumPollCount: 10,
};

const MediaToolName = {
  ImageGenerate: 'lobsterai_image_generate',
  VideoGenerate: 'lobsterai_video_generate',
  SkinManage: 'lobsterai_skin_manage',
} as const;

const MediaToolAction = {
  Generate: 'generate',
  List: 'list',
  Status: 'status',
  Cancel: 'cancel',
} as const;

const SkinManageAction = {
  CreateDraft: 'create_draft',
  RegisterAsset: 'register_asset',
  Status: 'status',
  Apply: 'apply',
  Deactivate: 'deactivate',
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const sanitizeArgsForLog = (args: Record<string, unknown>): Record<string, unknown> => {
  const prompt = typeof args.prompt === 'string' ? args.prompt : '';
  return {
    action: typeof args.action === 'string' ? args.action : 'generate',
    model: typeof args.model === 'string' ? args.model : '',
    promptLength: prompt.length,
    hasImage: typeof args.image === 'string',
    imageCount: Array.isArray(args.images) ? args.images.length : undefined,
    hasVideo: typeof args.video === 'string',
    videoCount: Array.isArray(args.videos) ? args.videos.length : undefined,
    aspectRatio: args.aspectRatio,
    resolution: args.resolution,
    size: args.size,
    n: args.n,
    count: args.count,
    quality: args.quality,
    outputFormat: args.outputFormat,
    output_format: args.output_format,
    temperature: args.temperature,
    imageSize: args.imageSize,
    durationSeconds: args.durationSeconds,
  };
};

const sanitizeSkinArgsForLog = (args: Record<string, unknown>): Record<string, unknown> => ({
  action: typeof args.action === 'string' ? args.action : '',
  skinId: typeof args.skinId === 'string' ? args.skinId : '',
  slot: typeof args.slot === 'string' ? args.slot : '',
  nameLength: typeof args.name === 'string' ? args.name.length : 0,
  baseThemeId: typeof args.baseThemeId === 'string' ? args.baseThemeId : '',
  hasSourcePath: typeof args.sourcePath === 'string' && args.sourcePath.length > 0,
});

const parsePluginConfig = (value: unknown): PluginConfig => {
  const raw = isRecord(value) ? value : {};
  return {
    callbackUrl: typeof raw.callbackUrl === 'string' ? raw.callbackUrl.trim() : '',
    secret: typeof raw.secret === 'string' ? raw.secret.trim() : '',
    requestTimeoutMs: typeof raw.requestTimeoutMs === 'number' ? raw.requestTimeoutMs : DEFAULT_TIMEOUT_MS,
  };
};

async function callMediaBridge(
  config: PluginConfig,
  request: MediaToolRequest,
): Promise<MediaToolResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(config.callbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lobster-media-secret': config.secret,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Media generation callback HTTP ${response.status}: ${text.trim() || response.statusText}`);
    }

    if (!text.trim()) {
      return { content: [{ type: 'text', text: 'No response from server.' }], isError: true };
    }

    const parsed = JSON.parse(text);
    if (isRecord(parsed) && Array.isArray(parsed.content)) {
      return parsed as MediaToolResponse;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
      details: isRecord(parsed) ? parsed as Record<string, unknown> : undefined,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { content: [{ type: 'text', text: 'Media generation request timed out.' }], isError: true };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function executeMediaStatusPolling(options: {
  config: PluginConfig;
  mediaType: MediaStatusType;
  policy: MediaStatusPollPolicy;
  tool: string;
  taskId: string;
  toolCallId: string;
  sessionKey: string;
  signal?: AbortSignal;
  onUpdate?: (result: MediaStatusUpdate) => void;
  log: (message: string) => void;
}): Promise<MediaToolResponse> {
  const statusConfig: PluginConfig = {
    ...options.config,
    requestTimeoutMs: Math.max(options.config.requestTimeoutMs, STATUS_REQUEST_TIMEOUT_MS),
  };
  return pollMediaStatus({
    mediaType: options.mediaType,
    taskId: options.taskId,
    toolCallId: options.toolCallId,
    policy: options.policy,
    signal: options.signal,
    onUpdate: options.onUpdate,
    log: message => options.log(`[lobster-media-generation] ${message}`),
    requestStatus: () => callMediaBridge(statusConfig, {
      tool: options.tool,
      args: { action: MediaToolAction.Status, taskId: options.taskId },
      context: { sessionKey: options.sessionKey, toolCallId: options.toolCallId },
    }),
  });
}

const ImageGenerateSchema = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal(MediaToolAction.Generate),
    Type.Literal(MediaToolAction.List),
    Type.Literal(MediaToolAction.Status),
  ], { description: 'Action to perform. Default: generate.' })),
  prompt: Type.Optional(Type.String({ description: 'Text prompt describing the image to generate.' })),
  model: Type.Optional(Type.String({ description: 'Model ID for generation. Use action=list to see available models.' })),
  image: Type.Optional(Type.String({ description: 'Single reference image absolute file path, URL, or data URL for image-to-image generation. If a media reference mapping is provided, use the mapped path; do not pass @ media tokens.' })),
  images: Type.Optional(Type.Array(Type.String(), { description: 'Multiple reference image absolute file paths, URLs, or data URLs for multi-image generation. If a media reference mapping is provided, use mapped paths; do not pass @ media tokens.' })),
  size: Type.Optional(Type.String({ description: 'Output size, e.g. "1024x1024".' })),
  aspectRatio: Type.Optional(Type.String({ description: 'Aspect ratio, e.g. "1:1", "16:9", "9:16".' })),
  resolution: Type.Optional(Type.String({ description: 'Resolution: "1K", "2K", "4K".' })),
  imageSize: Type.Optional(Type.String({ description: 'Image size for models that use imageConfig, e.g. "512px", "1K", "2K", "4K".' })),
  n: Type.Optional(Type.Number({ description: 'Number of images to generate. Default: 1. Alias of count for models that use n.', minimum: 1, maximum: 10 })),
  count: Type.Optional(Type.Number({ description: 'Number of images to generate. Default: 1.', minimum: 1, maximum: 10 })),
  quality: Type.Optional(Type.String({ description: 'Output quality, e.g. "low", "medium", "high", "auto".' })),
  outputFormat: Type.Optional(Type.String({ description: 'Output image format, e.g. "png", "jpeg", "webp".' })),
  output_format: Type.Optional(Type.String({ description: 'Output image format, e.g. "png", "jpeg", "webp". Alias of outputFormat.' })),
  temperature: Type.Optional(Type.Number({ description: 'Sampling temperature for image models that support it.', minimum: 0, maximum: 2 })),
  filename: Type.Optional(Type.String({ description: 'Suggested filename for the output.' })),
  taskId: Type.Optional(Type.String({ description: 'Task ID for status queries.' })),
  providerOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Model-specific options passed through to the provider.' })),
});

const VideoGenerateSchema = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal(MediaToolAction.Generate),
    Type.Literal(MediaToolAction.List),
    Type.Literal(MediaToolAction.Status),
    Type.Literal(MediaToolAction.Cancel),
  ], { description: 'Action to perform. Default: generate.' })),
  prompt: Type.Optional(Type.String({ description: 'Text prompt describing the video to generate. Chinese and English supported.' })),
  model: Type.Optional(Type.String({ description: 'Model ID for generation. Use action="list" to see available models and their supported parameters.' })),
  image: Type.Optional(Type.String({ description: 'Single reference image absolute file path, URL, or data URL (e.g. first frame for image-to-video). If a media reference mapping is provided, use the mapped path; do not pass @ media tokens.' })),
  images: Type.Optional(Type.Array(Type.String(), { description: 'Multiple reference image absolute file paths, URLs, or data URLs. Use with imageRoles to specify each image\'s role. If a media reference mapping is provided, use mapped paths; do not pass @ media tokens.' })),
  imageRoles: Type.Optional(Type.Array(Type.String(), { description: 'Role for each image: "first_frame", "last_frame", "reference_image". Must match images array length.' })),
  firstFrame: Type.Optional(Type.String({ description: 'First-frame image absolute file path, URL, or data URL for image-to-video models. If a media reference mapping is provided, use the mapped path; do not pass @ media tokens.' })),
  lastFrame: Type.Optional(Type.String({ description: 'Last-frame image absolute file path, URL, or data URL for first/last-frame video models. If a media reference mapping is provided, use the mapped path; do not pass @ media tokens.' })),
  referenceImages: Type.Optional(Type.Array(Type.String(), { description: 'Reference image absolute file paths, URLs, or data URLs for reference-to-video models. If a media reference mapping is provided, use mapped paths; do not pass @ media tokens.' })),
  media: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { description: 'Provider-native media array. Use only when the selected model documentation requires it.' })),
  video: Type.Optional(Type.String({ description: 'Single reference video absolute file path, URL, or data URL (for video-to-video generation). If a media reference mapping is provided, use the mapped path; do not pass @ media tokens.' })),
  videos: Type.Optional(Type.Array(Type.String(), { description: 'Multiple reference video absolute file paths, URLs, or data URLs. If a media reference mapping is provided, use mapped paths; do not pass @ media tokens.' })),
  videoRoles: Type.Optional(Type.Array(Type.String(), { description: 'Role for each video: "reference_video".' })),
  aspectRatio: Type.Optional(Type.String({ description: 'Aspect ratio: "16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive". Valid values depend on model; use action="list" to check.' })),
  resolution: Type.Optional(Type.String({ description: 'Resolution: "480p", "720p", "768P", "1080p". Valid values depend on model.' })),
  durationSeconds: Type.Optional(Type.Number({ description: 'Video duration in seconds. Valid range depends on model (e.g. Seedance 2.0: 4-15, MiniMax Hailuo: 6 or 10). Use -1 for auto. Use action="list" to check.', minimum: -1, maximum: 60 })),
  audio: Type.Optional(Type.Boolean({ description: 'Whether to generate synchronized audio (speech, sound effects, background music). Default: true.' })),
  watermark: Type.Optional(Type.Boolean({ description: 'Whether to include watermark. Default: false.' })),
  seed: Type.Optional(Type.Number({ description: 'Random seed for reproducibility (-1 for random). Same seed + same params produces similar results.' })),
  returnLastFrame: Type.Optional(Type.Boolean({ description: 'Return the last frame as PNG. Useful for generating continuous video sequences.' })),
  cameraFixed: Type.Optional(Type.Boolean({ description: 'Fix camera position (no movement). Not supported by all models.' })),
  filename: Type.Optional(Type.String({ description: 'Suggested filename for the output.' })),
  taskId: Type.Optional(Type.String({ description: 'Task ID for status/cancel queries.' })),
  providerOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Model-specific options passed through to the provider (e.g. prompt_optimizer, fast_pretreatment, priority, draft).' })),
});

const SkinPresentationPaletteSchema = Type.Object({
  canvas: Type.String({ description: 'Cowork canvas color as #RRGGBB.' }),
  panel: Type.String({ description: 'Sidebar and prompt surface color as #RRGGBB.' }),
  panelRaised: Type.String({ description: 'Raised surface color as #RRGGBB.' }),
  accent: Type.String({ description: 'Primary decorative accent as #RRGGBB.' }),
  accentForeground: Type.String({ description: 'Readable foreground color on the accent as #RRGGBB.' }),
  accentAlt: Type.String({ description: 'Secondary decorative accent as #RRGGBB.' }),
  foreground: Type.String({ description: 'Primary readable text color as #RRGGBB.' }),
  muted: Type.String({ description: 'Secondary readable text color as #RRGGBB.' }),
  border: Type.String({ description: 'Subtle skin border color as #RRGGBB.' }),
}, { additionalProperties: false });

const SkinPresentationSchema = Type.Object({
  mode: Type.Literal('immersive_shell'),
  palette: SkinPresentationPaletteSchema,
  art: Type.Optional(Type.Object({
    focusX: Type.Number({ minimum: 0, maximum: 1, description: 'Horizontal backdrop focal point.' }),
    focusY: Type.Number({ minimum: 0, maximum: 1, description: 'Vertical backdrop focal point.' }),
  }, { additionalProperties: false })),
  effects: Type.Optional(Type.Object({
    particleDensity: Type.Union([
      Type.Literal('none'),
      Type.Literal('sparse'),
    ]),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const SkinManageSchema = Type.Union([
  Type.Object({
    action: Type.Literal(SkinManageAction.CreateDraft),
    name: Type.String({ description: 'User-visible skin name.' }),
    baseThemeId: Type.Optional(Type.String({
      description: 'Legacy compatibility metadata. It does not control the light or dark appearance inferred from presentation colors.',
    })),
    presentation: Type.Optional(SkinPresentationSchema),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal(SkinManageAction.RegisterAsset),
    skinId: Type.String({ description: 'Skin draft ID returned by create_draft.' }),
    slot: Type.Union([
      Type.Literal('workspace.backdrop'),
      Type.Literal('home.emblem'),
    ], { description: 'Fixed skin asset slot.' }),
    sourcePath: Type.String({ description: 'Absolute path of the generated local image.' }),
  }),
  Type.Object({
    action: Type.Literal(SkinManageAction.Status),
    skinId: Type.String({ description: 'Skin draft ID returned by create_draft.' }),
  }),
  Type.Object({
    action: Type.Literal(SkinManageAction.Apply),
    skinId: Type.String({ description: 'Ready skin draft ID to activate.' }),
  }),
  Type.Object({
    action: Type.Literal(SkinManageAction.Deactivate),
  }),
], { description: 'Trusted desktop skin operation to perform.' });

const plugin = {
  id: 'lobster-media-generation',
  name: 'LobsterMediaGeneration',
  description: 'Image/video generation and AI skin management tools powered by LobsterAI.',
  configSchema: {
    parse(value: unknown): PluginConfig {
      return parsePluginConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    if (!config.callbackUrl || !config.secret) {
      api.logger.info('[lobster-media-generation] skipped: callbackUrl or secret not configured.');
      return;
    }

    api.registerTool((ctx) => {
      const sessionKey = ctx.sessionKey ?? '';
      if (!isLobsterAiDesktopSessionKey(sessionKey)) {
        return null;
      }

      return {
        name: MediaToolName.ImageGenerate,
        label: 'Image Generation',
        description: [
          'Generate images using LobsterAI server.',
          'Supports text-to-image and image-to-image generation.',
          'If the system prompt includes a LobsterAI media reference mapping, use mapped file paths or URLs in image/images arguments and never pass @ media tokens as tool argument values.',
          'Use action="list" to see available models and their capabilities.',
          'Use action="status" with taskId once; that call adaptively polls until the task reaches a terminal state. Do not busy-poll status yourself.',
          'Requires an active subscription with available image generation quota.',
        ].join(' '),
        parameters: ImageGenerateSchema,
        async execute(
          id: string,
          params: unknown,
          signal?: AbortSignal,
          onUpdate?: (result: MediaStatusUpdate) => void,
        ) {
          const args = (params ?? {}) as Record<string, unknown>;
          const action = typeof args.action === 'string' ? args.action : MediaToolAction.Generate;
          if (action === MediaToolAction.Status) {
            const taskId = typeof args.taskId === 'string' ? args.taskId : '';
            if (!taskId) {
              return { content: [{ type: 'text', text: 'taskId is required for status action.' }], isError: true };
            }
            try {
              return await executeMediaStatusPolling({
                config,
                mediaType: 'image',
                policy: IMAGE_STATUS_POLL_POLICY,
                tool: MediaToolName.ImageGenerate,
                taskId,
                toolCallId: id,
                sessionKey,
                signal,
                onUpdate,
                log: message => api.logger.info(message),
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              api.logger.info(`[lobster-media-generation] image status failed: toolCallId=${id} error=${message}`);
              return { content: [{ type: 'text', text: `Image status check failed: ${message}` }], isError: true };
            }
          }

          try {
            api.logger.info(`[lobster-media-generation] image tool (${action}) started: toolCallId=${id} args=${JSON.stringify(sanitizeArgsForLog(args))}`);
            const startedAt = Date.now();
            const result = await callMediaBridge(config, {
              tool: MediaToolName.ImageGenerate,
              args,
              context: { sessionKey, toolCallId: id },
            });
            api.logger.info(`[lobster-media-generation] image tool (${action}) completed: toolCallId=${id} elapsedMs=${Date.now() - startedAt} isError=${result.isError === true}`);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.logger.info(`[lobster-media-generation] image tool callback failed: toolCallId=${id} error=${message}`);
            return { content: [{ type: 'text', text: `Image generation failed: ${message}` }], isError: true };
          }
        },
      };
    });

    api.registerTool((ctx) => {
      const sessionKey = ctx.sessionKey ?? '';
      if (!isLobsterAiDesktopSessionKey(sessionKey)) {
        return null;
      }

      return {
        name: MediaToolName.VideoGenerate,
        label: 'Video Generation',
        description: [
          'Generate videos using LobsterAI server.',
          'Supports text-to-video, image-to-video, and video editing.',
          'For HappyHorse-1.1, pass model "HappyHorse-1.1"; the server selects happyhorse-1.1-t2v when no image is provided, happyhorse-1.1-i2v for one input image, and happyhorse-1.1-r2v for multiple input images. Do not pass the HappyHorse-1.1 submodel IDs directly.',
          'IMPORTANT: Different models have different valid parameters and value ranges.',
          'If the system prompt includes a LobsterAI media reference mapping, use mapped file paths or URLs in image/images/firstFrame/referenceImages/video/videos/media arguments and never pass @ media tokens as tool argument values.',
          'WORKFLOW: You MUST follow this three-step process:',
          'Step 1: Call with action="list" to see available models, their capabilities and supported parameters.',
          'Step 2: Call with action="generate" with chosen model and parameters. Returns a taskId.',
          'Step 3: Call with action="status" and the taskId. The tool will automatically poll with optimal intervals until completion; do NOT call status repeatedly yourself.',
          'Use action="cancel" with taskId only if the user explicitly requests cancellation. Note: only queued tasks can be cancelled; running tasks cannot be cancelled.',
          'Requires an active subscription with available video generation quota.',
        ].join(' '),
        parameters: VideoGenerateSchema,
        async execute(
          id: string,
          params: unknown,
          signal?: AbortSignal,
          onUpdate?: (result: MediaStatusUpdate) => void,
        ) {
          const args = (params ?? {}) as Record<string, unknown>;
          const action = typeof args.action === 'string' ? args.action : MediaToolAction.Generate;

          // status action: poll with adaptive intervals until terminal
          if (action === MediaToolAction.Status) {
            const taskId = typeof args.taskId === 'string' ? args.taskId : '';
            if (!taskId) {
              return { content: [{ type: 'text', text: 'taskId is required for status action.' }], isError: true };
            }

            try {
              return await executeMediaStatusPolling({
                config,
                mediaType: 'video',
                policy: VIDEO_STATUS_POLL_POLICY,
                tool: MediaToolName.VideoGenerate,
                taskId,
                toolCallId: id,
                sessionKey,
                signal,
                onUpdate,
                log: message => api.logger.info(message),
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              api.logger.info(`[lobster-media-generation] video status failed: toolCallId=${id} error=${message}`);
              return { content: [{ type: 'text', text: `Video status check failed: ${message}` }], isError: true };
            }
          }

          // All other actions (list, generate, cancel): pass through directly
          try {
            api.logger.info(`[lobster-media-generation] video tool (${action}) started: toolCallId=${id} args=${JSON.stringify(sanitizeArgsForLog(args))}`);
            const startedAt = Date.now();
            const result = await callMediaBridge(config, {
              tool: MediaToolName.VideoGenerate,
              args,
              context: { sessionKey, toolCallId: id },
            });
            api.logger.info(`[lobster-media-generation] video tool (${action}) completed: toolCallId=${id} elapsedMs=${Date.now() - startedAt} isError=${result.isError === true}`);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.logger.info(`[lobster-media-generation] video tool (${action}) failed: toolCallId=${id} error=${message}`);
            return { content: [{ type: 'text', text: `Video generation failed: ${message}` }], isError: true };
          }
        },
      };
    });

    api.registerTool((ctx) => {
      const sessionKey = ctx.sessionKey ?? '';
      if (!isLobsterAiDesktopSessionKey(sessionKey)) {
        return null;
      }

      return {
        name: MediaToolName.SkinManage,
        label: 'AI Skin Management',
        description: [
          'Create and manage a LobsterAI AI skin pack through the trusted desktop callback.',
          'This tool manages drafts and assets; it does not generate images.',
          'For a new pack, call create_draft with a name and an optional validated immersive-shell presentation first.',
          'LobsterAI deterministically infers a preferred light or dark appearance from presentation colors and applies it through the existing theme system; do not choose a color theme ID.',
          'Only allow-listed application and conversation title bars may use presentation colors. Page layout, system icons, and arbitrary CSS are never skin-controlled.',
          'Register only generated local files returned by an image tool.',
          'The only supported asset slots are workspace.backdrop followed by home.emblem.',
          'Use register_asset with skinId, slot, and sourcePath after each generation succeeds.',
          'Use status to verify readiness and apply only after the draft is ready. Deactivating removes custom imagery and presentation styling while keeping the current color theme.',
        ].join(' '),
        parameters: SkinManageSchema,
        async execute(id: string, params: unknown) {
          const args = (params ?? {}) as Record<string, unknown>;
          const action = typeof args.action === 'string' ? args.action : '';
          try {
            api.logger.info(`[lobster-media-generation] skin tool (${action}) started: toolCallId=${id} args=${JSON.stringify(sanitizeSkinArgsForLog(args))}`);
            const startedAt = Date.now();
            const result = await callMediaBridge(config, {
              tool: MediaToolName.SkinManage,
              args,
              context: { sessionKey, toolCallId: id },
            });
            api.logger.info(`[lobster-media-generation] skin tool (${action}) completed: toolCallId=${id} elapsedMs=${Date.now() - startedAt} isError=${result.isError === true}`);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.logger.info(`[lobster-media-generation] skin tool (${action}) failed: toolCallId=${id} error=${message}`);
            return { content: [{ type: 'text', text: `Skin management failed: ${message}` }], isError: true };
          }
        },
      };
    });

    api.logger.info('[lobster-media-generation] registered lobsterai_image_generate, lobsterai_video_generate, and lobsterai_skin_manage tools.');
  },
};

export default plugin;
