import type { AppConfig, SpeechConfig, SpeechProviderType } from '../config';
import { configService } from './config';

type SpeechProviderPreset = {
  provider: Exclude<SpeechProviderType, ''>;
  model: string;
  endpoint: string;
  mode: 'multipart-upload' | 'chat-completions';
};

type SpeechTranscriptionSuccess = { success: true; text: string };
type SpeechTranscriptionFailure = { success: false; error: string; raw?: unknown };
type SpeechTranscriptionResult = SpeechTranscriptionSuccess | SpeechTranscriptionFailure;

type TranscriptionRequestOptions = {
  audioBase64: string;
  mimeType: string;
  fileName: string;
};

type TranscriptionWithConfigOptions = TranscriptionRequestOptions & {
  speechConfig: SpeechConfig;
};

type SpeechAdapter = {
  transcribe: (config: SpeechConfig, options: TranscriptionRequestOptions) => Promise<SpeechTranscriptionResult>;
};

const SPEECH_PROVIDER_PRESETS: Record<Exclude<SpeechProviderType, ''>, SpeechProviderPreset> = {
  glm: {
    provider: 'glm',
    model: 'glm-asr-2512',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions',
    mode: 'multipart-upload',
  },
  qwen: {
    provider: 'qwen',
    model: 'qwen3-asr-flash',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    mode: 'chat-completions',
  },
};

function normalizeSpeechProvider(value: unknown): SpeechProviderType {
  if (value === 'glm' || value === 'qwen') {
    return value;
  }
  return '';
}

function normalizeSpeechLanguage(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSpeechApiKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getSpeechConfig(config: AppConfig): SpeechConfig {
  return {
    enabled: config.speech?.enabled === true,
    provider: normalizeSpeechProvider(config.speech?.provider),
    apiKey: normalizeSpeechApiKey(config.speech?.apiKey),
    language: normalizeSpeechLanguage(config.speech?.language),
  };
}

export function getSpeechProviderPreset(
  provider: SpeechProviderType
): SpeechProviderPreset | null {
  if (!provider) {
    return null;
  }
  return SPEECH_PROVIDER_PRESETS[provider] ?? null;
}

export function isSpeechInputAvailable(config: AppConfig): boolean {
  const speechConfig = getSpeechConfig(config);
  return speechConfig.enabled && !!speechConfig.provider && !!speechConfig.apiKey;
}

function normalizeAudioMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim() || 'audio/webm';
}

function inferAudioFormat(mimeType: string, fileName: string): string {
  const normalizedMimeType = normalizeAudioMimeType(mimeType);
  const mimeFormat = normalizedMimeType.split('/')[1]?.trim();
  if (mimeFormat) {
    return mimeFormat;
  }
  const extension = fileName.split('.').pop()?.trim();
  return extension || 'webm';
}

export function parseGlmTranscriptionResponse(raw: unknown): SpeechTranscriptionResult {
  if (raw && typeof raw === 'object' && typeof (raw as { text?: unknown }).text === 'string') {
    return {
      success: true,
      text: (raw as { text: string }).text,
    };
  }

  return {
    success: false,
    error: 'Malformed transcription response',
    raw,
  };
}

function extractTextFromQwenContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const textValue = (item as { text?: unknown }).text;
    if (typeof textValue === 'string') {
      return textValue;
    }
  }

  return null;
}

export function parseQwenTranscriptionResponse(raw: unknown): SpeechTranscriptionResult {
  if (!raw || typeof raw !== 'object') {
    return {
      success: false,
      error: 'Malformed transcription response',
      raw,
    };
  }

  const choices = (raw as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
  const text = extractTextFromQwenContent(firstChoice?.message?.content);

  if (text !== null) {
    return {
      success: true,
      text,
    };
  }

  return {
    success: false,
    error: 'Malformed transcription response',
    raw,
  };
}

const glmSpeechAdapter: SpeechAdapter = {
  async transcribe(config, options) {
    const preset = SPEECH_PROVIDER_PRESETS.glm;
    const response = await window.electron.speech.transcribe({
      url: preset.endpoint,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      audioBase64: options.audioBase64,
      mimeType: options.mimeType,
      fileName: options.fileName,
      model: preset.model,
      language: config.language?.trim() || undefined,
    });

    if (!response.success) {
      return {
        success: false,
        error: response.error || 'Speech transcription request failed',
        raw: response.raw,
      };
    }

    return parseGlmTranscriptionResponse(response.raw ?? { text: response.text });
  },
};

const qwenSpeechAdapter: SpeechAdapter = {
  async transcribe(config, options) {
    const preset = SPEECH_PROVIDER_PRESETS.qwen;
    const normalizedMimeType = normalizeAudioMimeType(options.mimeType);
    const format = inferAudioFormat(options.mimeType, options.fileName);
    const response = await window.electron.api.fetch({
      url: preset.endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: preset.model,
        modalities: ['text'],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: {
                  data: `data:${normalizedMimeType};base64,${options.audioBase64}`,
                  format,
                },
              },
              {
                type: 'text',
                text: config.language === 'en'
                  ? 'Please transcribe this audio accurately and only return the transcript.'
                  : '请将这段音频准确转写为简体中文文本，只返回转写结果。',
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      return {
        success: false,
        error: response.error || response.statusText || 'Speech transcription request failed',
        raw: response.data,
      };
    }

    return parseQwenTranscriptionResponse(response.data);
  },
};

const speechAdapters: Record<Exclude<SpeechProviderType, ''>, SpeechAdapter> = {
  glm: glmSpeechAdapter,
  qwen: qwenSpeechAdapter,
};

export async function transcribeAudioWithConfig(
  options: TranscriptionWithConfigOptions
): Promise<SpeechTranscriptionResult> {
  const speechConfig: SpeechConfig = {
    enabled: options.speechConfig.enabled === true,
    provider: normalizeSpeechProvider(options.speechConfig.provider),
    apiKey: normalizeSpeechApiKey(options.speechConfig.apiKey),
    language: normalizeSpeechLanguage(options.speechConfig.language),
  };

  if (!speechConfig.enabled || !speechConfig.provider || !speechConfig.apiKey) {
    return {
      success: false,
      error: 'No active speech route configured',
    };
  }

  const adapter = speechConfig.provider ? speechAdapters[speechConfig.provider] : null;
  if (!adapter) {
    return {
      success: false,
      error: 'Speech provider is invalid or unsupported',
    };
  }

  return adapter.transcribe(speechConfig, options);
}

export async function transcribeAudio(
  options: TranscriptionRequestOptions
): Promise<SpeechTranscriptionResult> {
  const config = configService.getConfig();
  const speechConfig = getSpeechConfig(config);

  return transcribeAudioWithConfig({
    ...options,
    speechConfig,
  });
}
