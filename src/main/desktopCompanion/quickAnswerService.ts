import type { WebContents } from 'electron';

import {
  type CompanionQuickAnswerEvent,
  CompanionQuickAnswerEventType,
  type CompanionQuickAnswerRequest,
  DesktopCompanionIpc,
} from '../../shared/desktopCompanion/constants';
import {
  buildCompanionQuickAnswerPrompt,
  COMPANION_SELECTION_MAX_CHARS,
  type CompanionQuickAnswerPrompt,
  CompanionSelectionAction,
  isCompanionSelectionAction,
} from '../../shared/desktopCompanion/selectionActions';
import { ApiFormat, ProviderName } from '../../shared/providers/constants';
import { getLanguage, t } from '../i18n';
import { resolveCurrentApiConfig, resolveRawApiConfig } from '../libs/claudeSettings';
import {
  buildAnthropicMessagesUrl,
  CoworkModelProtocol,
  extractApiErrorSnippet,
  normalizeGeminiBaseUrl,
} from '../libs/coworkModelApi';
import { getCoworkOpenAICompatProxyToken } from '../libs/coworkOpenAICompatProxy';
import { readAnthropicStreamEvent, readGeminiStreamEvent, splitSseEvents, type StreamChunk } from './sse';

const MAX_OUTPUT_TOKENS = 2_048;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_HISTORY_TURNS = 12;

export interface QuickAnswerModelConfig {
  protocol: CoworkModelProtocol;
  apiKey: string;
  baseURL: string;
  model: string;
  proxyToken?: string;
}

/** Same model the session title generator uses: the user's current default model. */
export function resolveQuickAnswerModel(): QuickAnswerModelConfig | null {
  const raw = resolveRawApiConfig();
  if (raw.config && raw.providerMetadata?.providerName === ProviderName.Gemini) {
    return { protocol: CoworkModelProtocol.GeminiNative, apiKey: raw.config.apiKey, baseURL: raw.config.baseURL, model: raw.config.model };
  }
  const resolved = resolveCurrentApiConfig();
  if (!resolved.config) return null;
  return {
    protocol: CoworkModelProtocol.Anthropic,
    apiKey: resolved.config.apiKey,
    baseURL: resolved.config.baseURL,
    model: resolved.config.model,
    // resolveCurrentApiConfig routes OpenAI providers through our local proxy.
    // Its Bearer token is separate from the upstream provider's API key.
    ...(resolved.config.apiType === ApiFormat.OpenAI ? { proxyToken: getCoworkOpenAICompatProxyToken() ?? undefined } : {}),
  };
}

export function buildQuickAnswerHttpRequest(config: QuickAnswerModelConfig, prompt: CompanionQuickAnswerPrompt): {
  url: string;
  init: RequestInit;
} {
  if (config.protocol === CoworkModelProtocol.GeminiNative) {
    return {
      url: `${normalizeGeminiBaseUrl(config.baseURL)}/models/${encodeURIComponent(config.model.trim())}:streamGenerateContent?alt=sse`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt.system }] },
          contents: prompt.messages.map(message => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
      },
    };
  }
  return {
    url: buildAnthropicMessagesUrl(config.baseURL),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01',
        ...(config.proxyToken ? { Authorization: `Bearer ${config.proxyToken}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: prompt.system,
        messages: prompt.messages,
        stream: true,
      }),
    },
  };
}

interface Running {
  controller: AbortController;
  ownerId: number;
}

interface QuickAnswerDeps {
  resolveModel(): QuickAnswerModelConfig | null;
  fetch: typeof fetch;
}

/**
 * Streams short, sessionless answers for the selection toolbar. These do not
 * go through the agent: they need no tools, should start in about a second,
 * and must not add a session for every translated sentence.
 */
export class CompanionQuickAnswerService {
  private running = new Map<string, Running>();

  constructor(private readonly deps: QuickAnswerDeps = { resolveModel: resolveQuickAnswerModel, fetch: (...args) => fetch(...args) }) {}

  start(sender: WebContents, request: CompanionQuickAnswerRequest): { success: boolean; error?: string } {
    const requestId = typeof request?.requestId === 'string' ? request.requestId.slice(0, 100) : '';
    const text = typeof request?.text === 'string' ? request.text.trim() : '';
    if (!requestId || !text || !isCompanionSelectionAction(request.action) || request.action === CompanionSelectionAction.Translate) {
      return { success: false, error: t('desktopCompanionRequestFailed') };
    }
    const model = this.deps.resolveModel();
    if (!model) return { success: false, error: t('desktopCompanionAnswerNoModel') };
    const history = Array.isArray(request.history)
      ? request.history.filter(turn => turn && typeof turn.content === 'string').slice(-MAX_HISTORY_TURNS)
      : [];
    const prompt = buildCompanionQuickAnswerPrompt({
      action: request.action,
      text: text.slice(0, COMPANION_SELECTION_MAX_CHARS),
      question: typeof request.question === 'string' ? request.question.slice(0, 4_000) : undefined,
      history,
      language: getLanguage(),
    });
    this.abort(requestId);
    const controller = new AbortController();
    this.running.set(requestId, { controller, ownerId: sender.id });
    void this.stream(sender, requestId, model, prompt, controller);
    return { success: true };
  }

  abort(requestId: string): void {
    this.running.get(requestId)?.controller.abort();
    this.running.delete(requestId);
  }

  abortOwnedBy(ownerId: number): void {
    for (const [requestId, running] of this.running) {
      if (running.ownerId === ownerId) this.abort(requestId);
    }
  }

  dispose(): void {
    for (const requestId of [...this.running.keys()]) this.abort(requestId);
  }

  private async stream(
    sender: WebContents,
    requestId: string,
    model: QuickAnswerModelConfig,
    prompt: CompanionQuickAnswerPrompt,
    controller: AbortController,
  ): Promise<void> {
    const send = (event: CompanionQuickAnswerEvent) => {
      if (!sender.isDestroyed()) sender.send(DesktopCompanionIpc.QuickAnswerEvent, event);
    };
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const read = model.protocol === CoworkModelProtocol.GeminiNative ? readGeminiStreamEvent : readAnthropicStreamEvent;
    try {
      const { url, init } = buildQuickAnswerHttpRequest(model, prompt);
      const response = await this.deps.fetch(url, { ...init, signal: controller.signal });
      if (!response.ok || !response.body) {
        const detail = extractApiErrorSnippet(await response.text().catch(() => '')) || `HTTP ${response.status}`;
        send({ requestId, type: CompanionQuickAnswerEventType.Error, message: t('desktopCompanionAnswerFailed', { error: detail }) });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = splitSseEvents(buffer);
        buffer = rest;
        for (const event of events) {
          const chunk: StreamChunk = read(event);
          if (chunk.error) {
            send({ requestId, type: CompanionQuickAnswerEventType.Error, message: t('desktopCompanionAnswerFailed', { error: chunk.error }) });
            return;
          }
          if (chunk.text) send({ requestId, type: CompanionQuickAnswerEventType.Delta, text: chunk.text });
        }
      }
      send({ requestId, type: CompanionQuickAnswerEventType.Done });
    } catch (error) {
      if (controller.signal.aborted && this.running.get(requestId)?.controller !== controller) return;
      const message = controller.signal.aborted ? 'timeout' : error instanceof Error ? error.message : String(error);
      console.warn('[DesktopCompanion] Quick answer failed:', message);
      send({ requestId, type: CompanionQuickAnswerEventType.Error, message: t('desktopCompanionAnswerFailed', { error: message }) });
    } finally {
      clearTimeout(timeout);
      if (this.running.get(requestId)?.controller === controller) this.running.delete(requestId);
    }
  }
}
