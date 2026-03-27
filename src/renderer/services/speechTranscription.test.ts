import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AppConfig } from '../config';
import { defaultConfig } from '../config';
import { configService } from './config';
import {
  getSpeechConfig,
  getSpeechProviderPreset,
  isSpeechInputAvailable,
  parseGlmTranscriptionResponse,
  parseQwenTranscriptionResponse,
  transcribeAudio,
  transcribeAudioWithConfig,
} from './speechTranscription';

const defaultProviders = defaultConfig.providers as NonNullable<AppConfig['providers']>;
const defaultSpeech = defaultConfig.speech as NonNullable<AppConfig['speech']>;

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...defaultConfig,
    ...overrides,
    providers: {
      ...defaultProviders,
      ...(overrides.providers ?? {}),
    },
    speech: {
      ...defaultSpeech,
      ...(overrides.speech ?? {}),
    },
  };
}

describe('speech config helpers', () => {
  test('returns a normalized standalone speech config', () => {
    const config = createConfig({
      speech: {
        enabled: true,
        provider: 'glm',
        apiKey: 'glm-key',
        language: 'zh',
      },
    });

    expect(getSpeechConfig(config)).toEqual({
      enabled: true,
      provider: 'glm',
      apiKey: 'glm-key',
      language: 'zh',
    });
  });

  test('reports speech input unavailable when provider or key is missing', () => {
    expect(isSpeechInputAvailable(createConfig())).toBe(false);
    expect(isSpeechInputAvailable(createConfig({
      speech: {
        enabled: true,
        provider: 'glm',
        apiKey: '',
      },
    }))).toBe(false);
  });

  test('reports speech input available when standalone speech config is valid', () => {
    expect(isSpeechInputAvailable(createConfig({
      speech: {
        enabled: true,
        provider: 'qwen',
        apiKey: 'test-key',
        language: 'zh',
      },
    }))).toBe(true);
  });

  test('returns provider presets for glm and qwen only', () => {
    expect(getSpeechProviderPreset('glm')).toMatchObject({
      provider: 'glm',
      model: 'glm-asr-2512',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions',
    });
    expect(getSpeechProviderPreset('qwen')).toMatchObject({
      provider: 'qwen',
      model: 'qwen3-asr-flash',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    });
    expect(getSpeechProviderPreset('')).toBeNull();
  });
});

describe('speech response parsers', () => {
  test('parses glm transcription responses with text', () => {
    expect(parseGlmTranscriptionResponse({ text: 'ni hao' })).toEqual({
      success: true,
      text: 'ni hao',
    });
  });

  test('parses qwen chat completions transcription responses with assistant content text', () => {
    expect(parseQwenTranscriptionResponse({
      choices: [
        {
          message: {
            content: 'hello from qwen',
          },
        },
      ],
    })).toEqual({
      success: true,
      text: 'hello from qwen',
    });
  });

  test('returns a failure when qwen response is malformed', () => {
    expect(parseQwenTranscriptionResponse({ choices: [] })).toEqual({
      success: false,
      error: 'Malformed transcription response',
      raw: { choices: [] },
    });
  });

  test('treats an empty qwen transcript as a successful transcription', () => {
    expect(parseQwenTranscriptionResponse({
      choices: [
        {
          message: {
            content: '',
          },
        },
      ],
    })).toEqual({
      success: true,
      text: '',
    });
  });
});

describe('transcribeAudio', () => {
  const speechTranscribeMock = vi.fn();
  const apiFetchMock = vi.fn();

  beforeEach(() => {
    vi.spyOn(configService, 'getConfig').mockReturnValue(createConfig());
    vi.stubGlobal('window', {
      configurable: true,
      electron: {
        speech: {
          transcribe: speechTranscribeMock,
        },
        api: {
          fetch: apiFetchMock,
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    speechTranscribeMock.mockReset();
    apiFetchMock.mockReset();
  });

  test('uses the glm adapter with the standalone speech config', async () => {
    vi.spyOn(configService, 'getConfig').mockReturnValue(createConfig({
      speech: {
        enabled: true,
        provider: 'glm',
        apiKey: 'glm-key',
        language: 'zh',
      },
    }));
    speechTranscribeMock.mockResolvedValue({
      success: true,
      text: 'glm result',
      raw: { text: 'glm result' },
    });

    const result = await transcribeAudio({
      audioBase64: 'ZmFrZQ==',
      mimeType: 'audio/webm',
      fileName: 'recording.webm',
    });

    expect(speechTranscribeMock).toHaveBeenCalledWith({
      url: 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions',
      headers: {
        Authorization: 'Bearer glm-key',
      },
      audioBase64: 'ZmFrZQ==',
      mimeType: 'audio/webm',
      fileName: 'recording.webm',
      model: 'glm-asr-2512',
      language: 'zh',
    });
    expect(result).toEqual({
      success: true,
      text: 'glm result',
    });
  });

  test('uses the qwen adapter with chat completions payload', async () => {
    vi.spyOn(configService, 'getConfig').mockReturnValue(createConfig({
      speech: {
        enabled: true,
        provider: 'qwen',
        apiKey: 'qwen-key',
        language: 'zh',
      },
    }));
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        choices: [
          {
            message: {
              content: 'qwen result',
            },
          },
        ],
      },
    });

    const result = await transcribeAudio({
      audioBase64: 'ZmFrZQ==',
      mimeType: 'audio/webm',
      fileName: 'recording.webm',
    });

    expect(apiFetchMock).toHaveBeenCalledWith({
      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer qwen-key',
      },
      body: JSON.stringify({
        model: 'qwen3-asr-flash',
        modalities: ['text'],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: {
                  data: 'data:audio/webm;base64,ZmFrZQ==',
                  format: 'webm',
                },
              },
              {
                type: 'text',
                text: '请将这段音频准确转写为简体中文文本，只返回转写结果。',
              },
            ],
          },
        ],
      }),
    });
    expect(result).toEqual({
      success: true,
      text: 'qwen result',
    });
  });

  test('can transcribe with an explicit unsaved speech config', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        choices: [
          {
            message: {
              content: 'test result',
            },
          },
        ],
      },
    });

    const result = await transcribeAudioWithConfig({
      speechConfig: {
        enabled: true,
        provider: 'qwen',
        apiKey: 'unsaved-key',
        language: 'zh',
      },
      audioBase64: 'dGVzdA==',
      mimeType: 'audio/webm',
      fileName: 'speech-input.webm',
    });

    expect(apiFetchMock).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer unsaved-key',
      }),
    }));
    expect(result).toEqual({
      success: true,
      text: 'test result',
    });
  });

  test('returns a failure when standalone speech config is unavailable', async () => {
    vi.spyOn(configService, 'getConfig').mockReturnValue(createConfig({
      speech: {
        enabled: true,
        provider: '',
        apiKey: '',
      },
    }));

    const result = await transcribeAudio({
      audioBase64: 'ZmFrZQ==',
      mimeType: 'audio/webm',
      fileName: 'recording.webm',
    });

    expect(result).toEqual({
      success: false,
      error: 'No active speech route configured',
    });
    expect(speechTranscribeMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
