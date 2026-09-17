/**
 * IM Chat Handler
 * Processes IM messages through LLM service with optional skills integration
 */

import axios from 'axios';
import {
  IMMessage,
  IMSettings,
} from './types';
import { buildIMMediaInstruction } from './imMediaInstruction';

// LLM Configuration interface (mirrors app_config structure)
interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model?: string;
  provider?: string;
}

export interface IMChatHandlerOptions {
  getLLMConfig: () => Promise<LLMConfig | null>;
  getSkillsPrompt?: () => Promise<string | null>;
  imSettings: IMSettings;
}

export class IMChatHandler {
  private options: IMChatHandlerOptions;

  constructor(options: IMChatHandlerOptions) {
    this.options = options;
  }

  /**
   * Process an incoming IM message and generate a response
   */
  async processMessage(message: IMMessage): Promise<string> {
    const llmConfig = await this.options.getLLMConfig();
    if (!llmConfig) {
      throw new Error('LLM configuration not found');
    }

    // Build system prompt with optional skills
    let systemPrompt = this.options.imSettings.systemPrompt || '';

    if (this.options.imSettings.skillsEnabled && this.options.getSkillsPrompt) {
      const skillsPrompt = await this.options.getSkillsPrompt();
      if (skillsPrompt) {
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n${skillsPrompt}`
          : skillsPrompt;
      }
    }

    // Append IM media sending instruction
    const mediaInstruction = buildIMMediaInstruction(this.options.imSettings);
    if (mediaInstruction) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${mediaInstruction}`
        : mediaInstruction;
    }

    // Call LLM API
    const response = await this.callLLM(llmConfig, message.content, systemPrompt);
    return response;
  }

  /**
   * Call LLM API and get response (non-streaming for simplicity)
   */
  private async callLLM(
    config: LLMConfig,
    userMessage: string,
    systemPrompt?: string
  ): Promise<string> {
    const provider = this.detectProvider(config);

    if (provider === 'anthropic') {
      return this.callAnthropicAPI(config, userMessage, systemPrompt);
    }

    // Default to OpenAI-compatible API
    return this.callOpenAICompatibleAPI(config, userMessage, systemPrompt);
  }

  /**
   * Detect provider from config
   */
  private detectProvider(config: LLMConfig): 'anthropic' | 'openai' {
    if (config.provider === 'anthropic') return 'anthropic';
    if (config.baseUrl.includes('anthropic')) return 'anthropic';
    if (config.model?.startsWith('claude')) return 'anthropic';
    return 'openai';
  }

  private buildOpenAICompatibleChatCompletionsUrl(config: LLMConfig): string {
    const normalized = config.baseUrl.replace(/\/+$/, '');
    if (!normalized) {
      return '/v1/chat/completions';
    }
    if (normalized.endsWith('/chat/completions')) {
      return normalized;
    }

    const isGeminiLike =
      config.provider === 'gemini'
      || config.model?.startsWith('gemini')
      || normalized.includes('generativelanguage.googleapis.com');
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

  private buildOpenAIResponsesUrl(config: LLMConfig): string {
    const normalized = config.baseUrl.replace(/\/+$/, '');
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

  private shouldUseOpenAIResponsesApi(config: LLMConfig): boolean {
    return config.provider?.toLowerCase() === 'openai';
  }

  private shouldUseMaxCompletionTokens(config: LLMConfig): boolean {
    const provider = config.provider?.toLowerCase();
    if (provider !== 'openai') {
      return false;
    }
    const normalizedModel = config.model?.toLowerCase() || '';
    const resolvedModel = normalizedModel.includes('/')
      ? normalizedModel.slice(normalizedModel.lastIndexOf('/') + 1)
      : normalizedModel;
    return resolvedModel.startsWith('gpt-5')
      || resolvedModel.startsWith('o1')
      || resolvedModel.startsWith('o3')
      || resolvedModel.startsWith('o4');
  }

  /**
   * Call Anthropic API
   */
  private async callAnthropicAPI(
    config: LLMConfig,
    userMessage: string,
    systemPrompt?: string
  ): Promise<string> {
    const url = `${config.baseUrl.replace(/\/$/, '')}/v1/messages`;

    const body: any = {
      model: config.model || 'claude-3-5-sonnet-20241022',
      max_tokens: 4096,
      messages: [{ role: 'user', content: userMessage }],
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const response = await axios.post(url, body, {
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    });

    // Extract text from response
    const content = response.data.content;
    if (Array.isArray(content)) {
      return content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('\n');
    }

    return content?.text || content || '';
  }

  /**
   * Call OpenAI-compatible API
   */
  private async callOpenAICompatibleAPI(
    config: LLMConfig,
    userMessage: string,
    systemPrompt?: string
  ): Promise<string> {
    const useResponsesApi = this.shouldUseOpenAIResponsesApi(config);
    const url = useResponsesApi
      ? this.buildOpenAIResponsesUrl(config)
      : this.buildOpenAICompatibleChatCompletionsUrl(config);

    const messages: Array<{ role: string; content: string }> = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userMessage });

    const body: Record<string, unknown> = useResponsesApi
      ? {
          model: config.model || 'gpt-4o',
          input: [{ role: 'user', content: [{ type: 'input_text', text: userMessage }] }],
          max_output_tokens: 4096,
        }
      : {
          model: config.model || 'gpt-4o',
          messages,
        };
    if (useResponsesApi && systemPrompt) {
      body.instructions = systemPrompt;
    }
    if (!useResponsesApi) {
      if (this.shouldUseMaxCompletionTokens(config)) {
        body.max_completion_tokens = 4096;
      } else {
        body.max_tokens = 4096;
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const response = await axios.post(url, body, { headers });

    if (useResponsesApi) {
      return this.extractResponsesText(response.data);
    }
    return response.data.choices?.[0]?.message?.content || '';
  }

  private extractResponsesText(payload: any): string {
    if (typeof payload?.output_text === 'string' && payload.output_text) {
      return payload.output_text;
    }

    const output = Array.isArray(payload?.output) ? payload.output : [];
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

  /**
   * Process message with streaming support
   * Yields content chunks as they arrive from the LLM
   */
  async *processMessageStream(
    message: IMMessage
  ): AsyncGenerator<{ content: string; done: boolean }> {
    const llmConfig = await this.options.getLLMConfig();
    if (!llmConfig) {
      throw new Error('LLM configuration not found');
    }

    // Build system prompt
    let systemPrompt = this.options.imSettings.systemPrompt || '';

    if (this.options.imSettings.skillsEnabled && this.options.getSkillsPrompt) {
      const skillsPrompt = await this.options.getSkillsPrompt();
      if (skillsPrompt) {
        systemPrompt = systemPrompt
          ? `${systemPrompt}\n\n${skillsPrompt}`
          : skillsPrompt;
      }
    }

    // Append IM media sending instruction
    const mediaInstruction = buildIMMediaInstruction(this.options.imSettings);
    if (mediaInstruction) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${mediaInstruction}`
        : mediaInstruction;
    }

    const provider = this.detectProvider(llmConfig);

    if (provider === 'anthropic') {
      yield* this.streamAnthropicAPI(llmConfig, message.content, systemPrompt);
    } else {
      yield* this.streamOpenAICompatibleAPI(llmConfig, message.content, systemPrompt);
    }
  }

  /**
   * Stream from Anthropic API using SSE
   */
  private async *streamAnthropicAPI(
    config: LLMConfig,
    userMessage: string,
    systemPrompt?: string
  ): AsyncGenerator<{ content: string; done: boolean }> {
    const url = `${config.baseUrl.replace(/\/$/, '')}/v1/messages`;

    const body: any = {
      model: config.model || 'claude-3-5-sonnet-20241022',
      max_tokens: 4096,
      messages: [{ role: 'user', content: userMessage }],
      stream: true,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${errorText}`);
    }

    if (!response.body) {
      throw new Error('No response body from Anthropic API');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            // Handle content_block_delta events
            if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
              const text = parsed.delta.text || '';
              if (text) {
                yield { content: text, done: false };
              }
            }
            // Handle message_stop event
            if (parsed.type === 'message_stop') {
              yield { content: '', done: true };
              return;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { content: '', done: true };
  }

  /**
   * Stream from OpenAI-compatible API using SSE
   */
  private async *streamOpenAICompatibleAPI(
    config: LLMConfig,
    userMessage: string,
    systemPrompt?: string
  ): AsyncGenerator<{ content: string; done: boolean }> {
    // OpenAI Responses API does not support streaming in the same way, fall back to non-streaming
    if (this.shouldUseOpenAIResponsesApi(config)) {
      const response = await this.callOpenAICompatibleAPI(config, userMessage, systemPrompt);
      yield { content: response, done: true };
      return;
    }

    const url = this.buildOpenAICompatibleChatCompletionsUrl(config);

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userMessage });

    const body: Record<string, unknown> = {
      model: config.model || 'gpt-4o',
      messages,
      stream: true,
    };

    if (this.shouldUseMaxCompletionTokens(config)) {
      body.max_completion_tokens = 4096;
    } else {
      body.max_tokens = 4096;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }

    if (!response.body) {
      throw new Error('No response body from OpenAI API');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              yield { content, done: false };
            }
            // Check for finish_reason
            if (parsed.choices?.[0]?.finish_reason) {
              yield { content: '', done: true };
              return;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { content: '', done: true };
  }
}