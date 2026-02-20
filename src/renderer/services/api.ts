import { store } from '../store';
import { configService } from './config';
import { ChatMessagePayload, ChatUserMessageInput, ImageAttachment } from '../types/chat';

export interface ApiConfig {
  apiKey: string;
  baseUrl: string;
  provider?: string;
  apiFormat?: 'anthropic' | 'openai';
}

export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: any
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// 生成唯一的请求 ID
const generateRequestId = () => `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

class ApiService {
  private config: ApiConfig | null = null;
  private currentRequestId: string | null = null;
  private cleanupFunctions: (() => void)[] = [];

  setConfig(config: ApiConfig) {
    this.config = config;
  }

  cancelOngoingRequest() {
    if (this.currentRequestId) {
      window.electron.api.cancelStream(this.currentRequestId);
      return true;
    }
    return false;
  }

  private cleanup() {
    this.cleanupFunctions.forEach(fn => fn());
    this.cleanupFunctions = [];
    this.currentRequestId = null;
  }

  private normalizeApiFormat(apiFormat: unknown): 'anthropic' | 'openai' {
    if (apiFormat === 'openai') {
      return 'openai';
    }
    return 'anthropic';
  }

  private buildOpenAICompatibleChatCompletionsUrl(baseUrl: string, provider: string): string {
    const normalized = baseUrl.trim().replace(/\/+$/, '');
    if (!normalized) {
      return '/v1/chat/completions';
    }
    if (normalized.endsWith('/chat/completions')) {
      return normalized;
    }

    const isGeminiLike = provider === 'gemini' || normalized.includes('generativelanguage.googleapis.com');
    if (isGeminiLike) {
      if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
        return `${normalized}/chat/completions`;
      }
      if (normalized.endsWith('/v1beta') || normalized.endsWith('/v1')) {
        const betaBase = normalized.endsWith('/v1')
          ? `${normalized.slice(0, -3)}v1beta`
          : normalized;
        return `${betaBase}/openai/chat/completions`;
      }
      return `${normalized}/v1beta/openai/chat/completions`;
    }

    if (normalized.endsWith('/v1')) {
      return `${normalized}/chat/completions`;
    }
    return `${normalized}/v1/chat/completions`;
  }

  private buildOpenAIResponsesUrl(baseUrl: string): string {
    const normalized = baseUrl.trim().replace(/\/+$/, '');
    if (!normalized) {
      return '/v1/responses';
    }
    if (normalized.endsWith('/responses')) {
      return normalized;
    }
    if (normalized.endsWith('/v1')) {
      return `${normalized}/responses`;
    }
    return `${normalized}/v1/responses`;
  }

  private shouldUseOpenAIResponsesApi(provider: string): boolean {
    return provider === 'openai';
  }

  private buildImageHint(images?: ImageAttachment[]): string {
    if (!images?.length) return '';
    return `[images: ${images.length}]`;
  }

  private mergeContentWithImageHint(content: string, images?: ImageAttachment[]): string {
    const hint = this.buildImageHint(images);
    if (!hint) return content;
    if (!content?.trim()) return hint;
    return `${content}\n\n${hint}`;
  }

  private extractImageData(image: ImageAttachment): { mimeType: string; data: string } | null {
    if (!image?.dataUrl) return null;
    const match = /^data:(.+);base64,(.*)$/.exec(image.dataUrl);
    if (match) {
      return { mimeType: match[1], data: match[2] };
    }
    if (image.type && image.dataUrl) {
      return { mimeType: image.type, data: image.dataUrl };
    }
    return null;
  }

  private formatOpenAIMessage(message: ChatMessagePayload, supportsImages: boolean) {
    if (supportsImages && message.images?.length) {
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = [];
      if (message.content?.trim()) {
        parts.push({ type: 'text', text: message.content });
      }
      message.images.forEach(image => {
        if (image.dataUrl) {
          parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
        }
      });
      if (!parts.length) return null;
      return { role: message.role, content: parts };
    }

    const content = supportsImages
      ? message.content
      : this.mergeContentWithImageHint(message.content, message.images);
    if (!content?.trim()) return null;
    return { role: message.role, content };
  }

  private formatOpenAIResponsesInputMessage(message: ChatMessagePayload, supportsImages: boolean) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';

    if (role === 'user' && supportsImages && message.images?.length) {
      const parts: Array<
        | { type: 'input_text'; text: string }
        | { type: 'input_image'; image_url: string }
      > = [];
      if (message.content?.trim()) {
        parts.push({ type: 'input_text', text: message.content });
      }
      message.images.forEach(image => {
        if (image.dataUrl) {
          parts.push({ type: 'input_image', image_url: image.dataUrl });
        }
      });
      if (!parts.length) return null;
      return { role, content: parts };
    }

    const content = supportsImages
      ? message.content
      : this.mergeContentWithImageHint(message.content, message.images);
    if (!content?.trim()) return null;
    if (role === 'assistant') {
      return { role, content: [{ type: 'output_text', text: content }] };
    }
    return { role, content: [{ type: 'input_text', text: content }] };
  }

  private extractResponsesOutputText(payload: any): string {
    const directOutputText = typeof payload?.output_text === 'string' ? payload.output_text : '';
    if (directOutputText) {
      return directOutputText;
    }

    const nestedOutputText = typeof payload?.response?.output_text === 'string'
      ? payload.response.output_text
      : '';
    if (nestedOutputText) {
      return nestedOutputText;
    }

    const output = Array.isArray(payload?.response?.output)
      ? payload.response.output
      : Array.isArray(payload?.output)
        ? payload.output
        : [];
    if (!Array.isArray(output)) {
      return '';
    }

    const chunks: string[] = [];
    output.forEach((item: any) => {
      if (!Array.isArray(item?.content)) {
        return;
      }
      item.content.forEach((contentItem: any) => {
        if (typeof contentItem?.text === 'string' && contentItem.text) {
          chunks.push(contentItem.text);
        }
      });
    });
    return chunks.join('');
  }

  private formatAnthropicMessage(message: ChatMessagePayload, supportsImages: boolean) {
    if (message.role === 'system') return null;
    if (supportsImages && message.images?.length) {
      const blocks: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
      > = [];
      if (message.content?.trim()) {
        blocks.push({ type: 'text', text: message.content });
      }
      message.images.forEach(image => {
        const payload = this.extractImageData(image);
        if (payload) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: payload.mimeType,
              data: payload.data,
            },
          });
        }
      });
      if (!blocks.length) return null;
      return { role: message.role, content: blocks };
    }

    const content = supportsImages
      ? message.content
      : this.mergeContentWithImageHint(message.content, message.images);
    if (!content?.trim()) return null;
    return { role: message.role, content };
  }

  private providerRequiresApiKey(provider: string): boolean {
    return provider !== 'ollama';
  }

  // 检测当前选择的模型属于哪个 provider
  private detectProvider(modelId: string, providerHint?: string): string {
    const normalizedHint = providerHint?.toLowerCase();
    if (
      normalizedHint
      && ['openai', 'deepseek', 'moonshot', 'zhipu', 'minimax', 'qwen', 'openrouter', 'gemini', 'anthropic', 'ollama'].includes(normalizedHint)
    ) {
      return normalizedHint;
    }
    const normalizedModelId = modelId.toLowerCase();
    if (normalizedModelId.startsWith('claude')) {
      return 'anthropic';
    } else if (normalizedModelId.startsWith('gpt') || normalizedModelId.startsWith('o1') || normalizedModelId.startsWith('o3')) {
      return 'openai';
    } else if (normalizedModelId.startsWith('gemini')) {
      return 'gemini';
    } else if (normalizedModelId.startsWith('deepseek')) {
      return 'deepseek';
    } else if (normalizedModelId.startsWith('kimi-')) {
      return 'moonshot';
    } else if (normalizedModelId.startsWith('glm-')) {
      return 'zhipu';
    } else if (normalizedModelId.startsWith('minimax')) {
      return 'minimax';
    } else if (normalizedModelId.startsWith('qwen') || normalizedModelId.startsWith('qvq')) {
      return 'qwen';
    }
    return 'openai'; // 默认使用 OpenAI 兼容格式
  }

  // 获取指定 provider 的配置
  private getProviderConfig(provider: string): ApiConfig | null {
    const appConfig = configService.getConfig();

    if (appConfig?.providers?.[provider]) {
      const providerConfig = appConfig.providers[provider];
      if (providerConfig.enabled && (providerConfig.apiKey || !this.providerRequiresApiKey(provider))) {
        return {
          apiKey: providerConfig.apiKey,
          baseUrl: providerConfig.baseUrl,
          provider: provider,
          apiFormat: this.normalizeApiFormat(providerConfig.apiFormat),
        };
      }
    }

    return null;
  }

  async chat(
    message: string | ChatUserMessageInput,
    onProgress?: (content: string, reasoning?: string) => void,
    history: ChatMessagePayload[] = []
  ): Promise<{ content: string; reasoning?: string }> {
    if (!this.config) {
      throw new ApiError('API configuration not set. Please configure your API settings in the settings menu.');
    }

    const selectedModel = store.getState().model.selectedModel;
    const provider = this.detectProvider(selectedModel.id, selectedModel.provider);
    const supportsImages = !!selectedModel.supportsImage;
    const userMessage: ChatUserMessageInput = typeof message === 'string'
      ? { content: message }
      : { content: message.content || '', images: message.images };

    // 尝试获取模型对应 provider 的配置
    let effectiveConfig = this.config;
    const providerConfig = this.getProviderConfig(provider);
    if (providerConfig) {
      effectiveConfig = providerConfig;
    }

    if (this.providerRequiresApiKey(provider) && !effectiveConfig.apiKey) {
      throw new ApiError('API key is not configured. Please set your API key in the settings menu.');
    }

    // 根据 API 协议格式决定调用方式：
    // - anthropic: Anthropic 兼容协议 (/v1/messages)
    // - openai: OpenAI 兼容协议 (OpenAI provider uses /v1/responses)
    const normalizedApiFormat = this.normalizeApiFormat(effectiveConfig.apiFormat);
    const useOpenAIFormat = normalizedApiFormat === 'openai';

    if (!useOpenAIFormat) {
      return this.chatWithAnthropic(userMessage, onProgress, history, selectedModel.id, effectiveConfig, supportsImages);
    }

    return this.chatWithOpenAICompatible(userMessage, onProgress, history, selectedModel.id, effectiveConfig, supportsImages, provider);
  }

  // Anthropic API 调用
  private async chatWithAnthropic(
    message: ChatUserMessageInput,
    onProgress?: (content: string, reasoning?: string) => void,
    history: ChatMessagePayload[] = [],
    modelId: string = 'claude-3-5-sonnet-20241022',
    config: ApiConfig = this.config!,
    supportsImages: boolean = false
  ): Promise<{ content: string; reasoning?: string }> {
    let fullContent = '';
    let fullReasoning = '';

    try {
      this.cancelOngoingRequest();
      const requestId = generateRequestId();
      this.currentRequestId = requestId;

      // Anthropic 需要将 history 中的 system 消息分离出来
      const systemMessages = history.filter(m => m.role === 'system');
      const nonSystemMessages = history.filter(m => m.role !== 'system');

      const formattedHistory = nonSystemMessages
        .map(item => this.formatAnthropicMessage(item, supportsImages))
        .filter(Boolean);
      const formattedUserMessage = this.formatAnthropicMessage({
        role: 'user',
        content: message.content,
        images: message.images,
      }, supportsImages);
      const messages = [
        ...formattedHistory,
        ...(formattedUserMessage ? [formattedUserMessage] : []),
      ];

      const requestBody: any = {
        model: modelId,
        max_tokens: 8192,
        messages: messages,
        stream: true,
      };

      // 添加 system 消息
      if (systemMessages.length > 0) {
        const systemContent = systemMessages
          .map(m => this.mergeContentWithImageHint(m.content, supportsImages ? undefined : m.images))
          .filter(Boolean)
          .join('\n');
        if (systemContent) {
          requestBody.system = systemContent;
        }
      }

      // 检测是否是 thinking 模型
      const isThinkingModel = modelId.includes('claude-3-7') ||
                              modelId.includes('claude-sonnet-4') ||
                              modelId.includes('claude-opus-4');

      if (isThinkingModel) {
        requestBody.thinking = {
          type: 'enabled',
          budget_tokens: 10000
        };
        // Thinking 模型需要更大的 max_tokens
        requestBody.max_tokens = 16000;
      }

      return new Promise((resolve, reject) => {
        let aborted = false;

        // 设置流式监听器
        const removeDataListener = window.electron.api.onStreamData(requestId, (chunk) => {
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);

                // Anthropic SSE 事件处理
                if (parsed.type === 'content_block_delta') {
                  const delta = parsed.delta;
                  if (delta.type === 'text_delta') {
                    fullContent += delta.text;
                    onProgress?.(fullContent, fullReasoning || undefined);
                  } else if (delta.type === 'thinking_delta') {
                    fullReasoning += delta.thinking;
                    onProgress?.(fullContent, fullReasoning || undefined);
                  }
                }
              } catch (e) {
                console.warn('Failed to parse SSE message:', e);
              }
            }
          }
        });

        const removeDoneListener = window.electron.api.onStreamDone(requestId, () => {
          this.cleanup();
          if (!fullContent) {
            reject(new ApiError('No content received from the API. Please try again.'));
          } else {
            resolve({ content: fullContent, reasoning: fullReasoning || undefined });
          }
        });

        const removeErrorListener = window.electron.api.onStreamError(requestId, (error) => {
          this.cleanup();
          reject(new ApiError(error));
        });

        const removeAbortListener = window.electron.api.onStreamAbort(requestId, () => {
          aborted = true;
          this.cleanup();
          resolve({ content: fullContent || 'Response was stopped.', reasoning: fullReasoning || undefined });
        });

        this.cleanupFunctions = [removeDataListener, removeDoneListener, removeErrorListener, removeAbortListener];

        // 发起流式请求
        window.electron.api.stream({
          url: `${config.baseUrl}/v1/messages`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(requestBody),
          requestId,
        }).then((response) => {
          if (!response.ok && !aborted) {
            this.cleanup();
            let errorMessage = 'API request failed';
            if (response.error) {
              try {
                const errorData = JSON.parse(response.error);
                if (errorData.error?.message) {
                  errorMessage = errorData.error.message;
                }
              } catch {
                errorMessage = response.error;
              }
            }
            reject(new ApiError(errorMessage, response.status));
          }
        }).catch((error) => {
          if (!aborted) {
            this.cleanup();
            reject(new ApiError(error.message || 'Network error'));
          }
        });
      });
    } catch (error) {
      this.cleanup();
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError('An unexpected error occurred while calling the API. Please try again.');
    }
  }

  // OpenAI 兼容 API 调用 (OpenAI, DeepSeek, etc.)
  private async chatWithOpenAICompatible(
    message: ChatUserMessageInput,
    onProgress?: (content: string, reasoning?: string) => void,
    history: ChatMessagePayload[] = [],
    modelId: string = 'gpt-4',
    config: ApiConfig = this.config!,
    supportsImages: boolean = false,
    provider: string = 'openai'
  ): Promise<{ content: string; reasoning?: string }> {
    let fullContent = '';
    let fullReasoning = '';

    try {
      this.cancelOngoingRequest();
      const requestId = generateRequestId();
      this.currentRequestId = requestId;
      const useResponsesApi = this.shouldUseOpenAIResponsesApi(provider);

      const userMessage: ChatMessagePayload = {
        role: 'user',
        content: message.content,
        images: message.images,
      };
      const messages = [
        ...history,
        userMessage,
      ]
        .map(item => this.formatOpenAIMessage(item, supportsImages))
        .filter(Boolean);
      const systemInstructions = history
        .filter(item => item.role === 'system')
        .map(item => this.mergeContentWithImageHint(item.content, supportsImages ? undefined : item.images))
        .filter(Boolean)
        .join('\n');
      const responseInputMessages = [
        ...history.filter(item => item.role !== 'system'),
        userMessage,
      ]
        .map(item => this.formatOpenAIResponsesInputMessage(item, supportsImages))
        .filter(Boolean);

      return new Promise((resolve, reject) => {
        let aborted = false;
        let sseBuffer = '';
        let currentEvent = '';

        // 设置流式监听器
        const removeDataListener = window.electron.api.onStreamData(requestId, (chunk) => {
          sseBuffer += chunk;
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';

          for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');
            if (!line) {
              currentEvent = '';
              continue;
            }
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
              continue;
            }
            if (!line.startsWith('data: ')) {
              continue;
            }

            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);

              if (useResponsesApi) {
                const eventType = currentEvent || String(parsed.type || '');
                const content = (
                  (eventType === 'response.output_text.delta' || eventType === 'response.output.delta')
                  && typeof parsed.delta === 'string'
                )
                  ? parsed.delta
                  : '';
                const reasoning = (
                  eventType === 'response.reasoning_summary_text.delta'
                  && typeof parsed.delta === 'string'
                )
                  ? parsed.delta
                  : '';
                const completedText = (
                  eventType === 'response.completed'
                  || eventType === 'response.output_item.done'
                )
                  ? this.extractResponsesOutputText(parsed)
                  : '';

                if (content) {
                  fullContent += content;
                }
                if (reasoning) {
                  fullReasoning += reasoning;
                }
                if (!fullContent && completedText) {
                  fullContent = completedText;
                }
                if (content || reasoning || completedText) {
                  onProgress?.(fullContent, fullReasoning || undefined);
                }
                continue;
              }

              const delta = parsed.choices?.[0]?.delta || {};
              const content = typeof delta.content === 'string' ? delta.content : '';
              const reasoning = typeof delta.reasoning_content === 'string'
                ? delta.reasoning_content
                : typeof delta.reasoning === 'string'
                  ? delta.reasoning
                  : typeof delta.thoughts === 'string'
                    ? delta.thoughts
                    : '';

              if (content) {
                fullContent += content;
              }
              if (reasoning) {
                fullReasoning += reasoning;
              }
              if (content || reasoning) {
                onProgress?.(fullContent, fullReasoning || undefined);
              }
            } catch (e) {
              console.warn('Failed to parse SSE message:', e);
            }
          }
        });

        const removeDoneListener = window.electron.api.onStreamDone(requestId, () => {
          this.cleanup();
          if (!fullContent) {
            reject(new ApiError('No content received from the API. Please try again.'));
          } else {
            resolve({ content: fullContent, reasoning: fullReasoning || undefined });
          }
        });

        const removeErrorListener = window.electron.api.onStreamError(requestId, (error) => {
          this.cleanup();
          reject(new ApiError(error));
        });

        const removeAbortListener = window.electron.api.onStreamAbort(requestId, () => {
          aborted = true;
          this.cleanup();
          resolve({ content: fullContent || 'Response was stopped.', reasoning: fullReasoning || undefined });
        });

        this.cleanupFunctions = [removeDataListener, removeDoneListener, removeErrorListener, removeAbortListener];

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (config.apiKey) {
          headers.Authorization = `Bearer ${config.apiKey}`;
        }

        const requestUrl = useResponsesApi
          ? this.buildOpenAIResponsesUrl(config.baseUrl)
          : this.buildOpenAICompatibleChatCompletionsUrl(config.baseUrl, provider);
        const requestBody: Record<string, unknown> = useResponsesApi
          ? {
              model: modelId,
              input: responseInputMessages,
              stream: true,
            }
          : {
              model: modelId,
              messages: messages,
              stream: true,
            };
        if (useResponsesApi && systemInstructions) {
          requestBody.instructions = systemInstructions;
        }

        window.electron.api.stream({
          url: requestUrl,
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          requestId,
        }).then((response) => {
          if (!response.ok && !aborted) {
            this.cleanup();
            let errorMessage = 'API request failed';
            if (response.error) {
              try {
                const errorData = JSON.parse(response.error);
                if (errorData.error?.message) {
                  errorMessage = errorData.error.message;
                }
              } catch {
                errorMessage = response.error;
              }
            }
            reject(new ApiError(errorMessage, response.status));
          }
        }).catch((error) => {
          if (!aborted) {
            this.cleanup();
            reject(new ApiError(error.message || 'Network error'));
          }
        });
      });
    } catch (error) {
      this.cleanup();
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError('An unexpected error occurred while calling the API. Please try again.');
    }
  }
}

export const apiService = new ApiService();
