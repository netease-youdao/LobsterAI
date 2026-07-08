import { Type } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

import { isLobsterAiDesktopSessionKey } from './sessionKey';

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

type MediaToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
};

const DEFAULT_TIMEOUT_MS = 120_000;

// Video polling configuration
const VIDEO_POLL_TIMEOUT_MS = 36_000_000; // 10 hours
const VIDEO_POLL_FAST_MS = 10_000;
const VIDEO_POLL_SLOW_MS = 30_000;
const VIDEO_POLL_MEDIUM_MS = 120_000;
const VIDEO_POLL_IDLE_MS = 600_000;
const VIDEO_POLL_FAST_COUNT = 6;
const VIDEO_POLL_SLOW_COUNT = 18;
const VIDEO_POLL_MEDIUM_COUNT = 10;
const VIDEO_STATUS_REQUEST_TIMEOUT_MS = 30_000;

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

function getPollInterval(pollCount: number): number {
  if (pollCount < VIDEO_POLL_FAST_COUNT) return VIDEO_POLL_FAST_MS;
  if (pollCount < VIDEO_POLL_FAST_COUNT + VIDEO_POLL_SLOW_COUNT) return VIDEO_POLL_SLOW_MS;
  if (pollCount < VIDEO_POLL_FAST_COUNT + VIDEO_POLL_SLOW_COUNT + VIDEO_POLL_MEDIUM_COUNT) return VIDEO_POLL_MEDIUM_MS;
  return VIDEO_POLL_IDLE_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTerminalStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function readPollCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function extractResponseText(response: MediaToolResponse): string {
  return response.content
    .map(item => item.text)
    .filter(text => typeof text === 'string' && text.trim())
    .join('\n')
    .trim();
}

const ImageGenerateSchema = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal('generate'),
    Type.Literal('list'),
    Type.Literal('status'),
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
    Type.Literal('generate'),
    Type.Literal('list'),
    Type.Literal('status'),
    Type.Literal('cancel'),
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
  aspectRatio: Type.Optional(Type.String({ description: 'Aspect ratio: "16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive". Valid values depend on model — use action="list" to check.' })),
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

const plugin = {
  id: 'lobster-media-generation',
  name: 'LobsterMediaGeneration',
  description: 'Image and video generation tools powered by LobsterAI server.',
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
        name: 'lobsterai_image_generate',
        label: 'Image Generation',
        description: [
          'Generate images using LobsterAI server.',
          'Supports text-to-image and image-to-image generation.',
          'If the system prompt includes a LobsterAI media reference mapping, use mapped file paths or URLs in image/images arguments and never pass @ media tokens as tool argument values.',
          'Use action="list" to see available models and their capabilities.',
          'Use action="status" with taskId to check async task progress.',
          'Requires an active subscription with available image generation quota.',
        ].join(' '),
        parameters: ImageGenerateSchema,
        async execute(id: string, params: unknown) {
          const args = (params ?? {}) as Record<string, unknown>;
          try {
            api.logger.info(`[lobster-media-generation] image tool callback started: toolCallId=${id} args=${JSON.stringify(sanitizeArgsForLog(args))}`);
            const startedAt = Date.now();
            const result = await callMediaBridge(config, {
              tool: 'lobsterai_image_generate',
              args,
              context: { sessionKey, toolCallId: id },
            });
            api.logger.info(`[lobster-media-generation] image tool callback completed: toolCallId=${id} elapsedMs=${Date.now() - startedAt} isError=${result.isError === true}`);
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
        name: 'lobsterai_video_generate',
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
          'Step 3: Call with action="status" and the taskId. The tool will automatically poll with optimal intervals until completion — do NOT call status repeatedly yourself.',
          'Use action="cancel" with taskId only if the user explicitly requests cancellation. Note: only queued tasks can be cancelled; running tasks cannot be cancelled.',
          'Requires an active subscription with available video generation quota.',
        ].join(' '),
        parameters: VideoGenerateSchema,
        async execute(id: string, params: unknown, _signal?: AbortSignal, onUpdate?: (result: { content: Array<{type: string; text: string}>; details?: Record<string, unknown> }) => void) {
          const args = (params ?? {}) as Record<string, unknown>;
          const action = typeof args.action === 'string' ? args.action : 'generate';

          // status action: poll with adaptive intervals until terminal
          if (action === 'status') {
            const taskId = typeof args.taskId === 'string' ? args.taskId : '';
            if (!taskId) {
              return { content: [{ type: 'text', text: 'taskId is required for status action.' }], isError: true };
            }

            try {
              api.logger.info(`[lobster-media-generation] video status polling started: toolCallId=${id} taskId=${taskId}`);
              const startedAt = Date.now();
              const statusConfig: PluginConfig = { ...config, requestTimeoutMs: VIDEO_STATUS_REQUEST_TIMEOUT_MS };
              let pollCount = 0;
              let upstreamTaskId: string | undefined;
              let firstStatusOutput: string | undefined;
              let latestReportedPollCount = 0;

              while (true) {
                const elapsed = Date.now() - startedAt;
                if (elapsed >= VIDEO_POLL_TIMEOUT_MS) {
                  api.logger.info(`[lobster-media-generation] video status poll timeout: toolCallId=${id} taskId=${taskId} elapsedMs=${elapsed} pollCount=${pollCount}`);
                  return {
                    content: [{ type: 'text', text: `Video generation timed out after ${Math.round(elapsed / 60_000)} minutes.\nTask ID: ${upstreamTaskId || taskId}\nYou can check status later with action="status".` }],
                    isError: true,
                    details: { taskId, upstreamTaskId, status: 'timeout', pollCount: latestReportedPollCount || pollCount },
                  };
                }

                if (pollCount > 0) {
                  const interval = getPollInterval(pollCount - 1);
                  await sleep(interval);
                }

                pollCount++;

                try {
                  const statusResult = await callMediaBridge(statusConfig, {
                    tool: 'lobsterai_video_generate',
                    args: { action: 'status', taskId },
                    context: { sessionKey, toolCallId: id },
                  });

                  const statusDetails = statusResult.details ?? {};
                  const currentStatus = statusDetails.status as string | undefined;
                  const reportedPollCount = readPollCount(statusDetails.pollCount) ?? pollCount;
                  latestReportedPollCount = Math.max(latestReportedPollCount, reportedPollCount);
                  if (!upstreamTaskId && statusDetails.upstreamTaskId) {
                    upstreamTaskId = String(statusDetails.upstreamTaskId);
                  }
                  const statusOutput = extractResponseText(statusResult);
                  if (!firstStatusOutput && statusOutput) {
                    firstStatusOutput = statusOutput;
                  }

                  if (onUpdate) {
                    onUpdate({
                      content: [{ type: 'text', text: firstStatusOutput || `Task ID: ${upstreamTaskId || taskId}` }],
                      details: {
                        taskId,
                        upstreamTaskId,
                        pollCount: latestReportedPollCount,
                        ...(currentStatus ? { status: currentStatus } : {}),
                        ...(firstStatusOutput ? { firstStatusOutput } : {}),
                        isMediaStatusPolling: true,
                        mediaType: 'video',
                      },
                    });
                  }

                  if (currentStatus && isTerminalStatus(currentStatus)) {
                    api.logger.info(`[lobster-media-generation] video status poll complete: toolCallId=${id} taskId=${taskId} status=${currentStatus} elapsedMs=${Date.now() - startedAt} pollCount=${pollCount}`);
                    return {
                      ...statusResult,
                      details: {
                        ...statusResult.details,
                        taskId,
                        upstreamTaskId,
                        pollCount: latestReportedPollCount,
                      },
                    };
                  }

                  if (pollCount % 6 === 0) {
                    const progress = statusDetails.progress ?? 'unknown';
                    api.logger.info(`[lobster-media-generation] video status poll progress: toolCallId=${id} taskId=${taskId} pollCount=${pollCount} progress=${progress} elapsedMs=${Date.now() - startedAt}`);
                  }
                } catch (pollError) {
                  const pollMsg = pollError instanceof Error ? pollError.message : String(pollError);
                  api.logger.info(`[lobster-media-generation] video status poll error (will retry): toolCallId=${id} taskId=${taskId} pollCount=${pollCount} error=${pollMsg}`);
                }
              }
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
              tool: 'lobsterai_video_generate',
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

    api.logger.info('[lobster-media-generation] registered lobsterai_image_generate and lobsterai_video_generate tools.');
  },
};

export default plugin;
