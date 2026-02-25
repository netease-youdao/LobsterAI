import http from 'http';
import { BrowserWindow, session } from 'electron';
import {
  anthropicToOpenAI,
  buildOpenAIChatCompletionsURL,
  formatSSEEvent,
  mapStopReason,
  openAIToAnthropic,
  type OpenAIStreamChunk,
} from './coworkFormatTransform';
import { loadPiAi } from './piAiLoader';
import type { ScheduledTaskStore, ScheduledTaskInput } from '../scheduledTaskStore';
import type { Scheduler } from './scheduler';
import {
  getAntigravityProjectId,
  normalizeAntigravityModelId,
  parseOAuthApiKeyPayload,
} from '../oauth/providers/googleAntigravity';

export type OpenAICompatUpstreamConfig = {
  baseURL: string;
  apiKey?: string;
  model: string;
  provider?: string;
  upstreamKind?: 'openai' | 'antigravity';
  providerModelId?: string;
  resolveAuthApiKey?: (forceRefresh?: boolean) => Promise<string>;
};

export type OpenAICompatProxyStatus = {
  running: boolean;
  baseURL: string | null;
  hasUpstream: boolean;
  upstreamBaseURL: string | null;
  upstreamModel: string | null;
  upstreamKind: 'openai' | 'antigravity' | null;
  lastError: string | null;
};

type ToolCallState = {
  id?: string;
  name?: string;
  extraContent?: unknown;
};

type StreamState = {
  messageId: string | null;
  model: string | null;
  contentIndex: number;
  currentBlockType: 'thinking' | 'text' | 'tool_use' | null;
  activeToolIndex: number | null;
  hasMessageStart: boolean;
  hasMessageStop: boolean;
  toolCalls: Record<number, ToolCallState>;
};

const LOCAL_HOST = '127.0.0.1';
const DEFAULT_PI_MODEL_MAX_TOKENS = 65536;
const DEFAULT_PI_MODEL_CONTEXT_WINDOW = 1048576;
const DEFAULT_ANTIGRAVITY_REQUEST_TIMEOUT_MS = 120000;
const BASE64_THOUGHT_SIGNATURE_RE = /^[A-Za-z0-9+/]+={0,2}$/;

let proxyServer: http.Server | null = null;
let proxyPort: number | null = null;
let upstreamConfig: OpenAICompatUpstreamConfig | null = null;
let lastProxyError: string | null = null;
const toolCallExtraContentById = new Map<string, unknown>();
const MAX_TOOL_CALL_EXTRA_CONTENT_CACHE = 1024;

// --- Scheduled task API dependencies ---
interface ScheduledTaskDeps {
  getScheduledTaskStore: () => ScheduledTaskStore;
  getScheduler: () => Scheduler;
}
let scheduledTaskDeps: ScheduledTaskDeps | null = null;

export function setScheduledTaskDeps(deps: ScheduledTaskDeps): void {
  scheduledTaskDeps = deps;
}

function toOptionalObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeScheduledTaskWorkingDirectory(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';

  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  // Sandbox guest workspace roots are not valid host directories.
  if (/^(?:[A-Za-z]:)?\/workspace(?:\/project)?$/i.test(normalized)) {
    return '';
  }
  return raw;
}

function normalizeToolCallExtraContent(toolCallObj: Record<string, unknown>): unknown {
  if (toolCallObj.extra_content !== undefined) {
    return toolCallObj.extra_content;
  }

  const functionObj = toOptionalObject(toolCallObj.function);
  if (functionObj?.extra_content !== undefined) {
    return functionObj.extra_content;
  }

  const thoughtSignature = toString(functionObj?.thought_signature);
  if (!thoughtSignature) {
    return undefined;
  }

  return {
    google: {
      thought_signature: thoughtSignature,
    },
  };
}

function cacheToolCallExtraContent(toolCallId: string, extraContent: unknown): void {
  if (!toolCallId || extraContent === undefined) {
    return;
  }

  toolCallExtraContentById.set(toolCallId, extraContent);

  if (toolCallExtraContentById.size > MAX_TOOL_CALL_EXTRA_CONTENT_CACHE) {
    const oldestKey = toolCallExtraContentById.keys().next().value;
    if (typeof oldestKey === 'string') {
      toolCallExtraContentById.delete(oldestKey);
    }
  }
}

function cacheToolCallExtraContentFromOpenAIToolCalls(toolCalls: unknown): void {
  for (const toolCall of toArray(toolCalls)) {
    const toolCallObj = toOptionalObject(toolCall);
    if (!toolCallObj) {
      continue;
    }

    const toolCallId = toString(toolCallObj.id);
    const extraContent = normalizeToolCallExtraContent(toolCallObj);
    cacheToolCallExtraContent(toolCallId, extraContent);
  }
}

function cacheToolCallExtraContentFromOpenAIResponse(body: unknown): void {
  const responseObj = toOptionalObject(body);
  if (!responseObj) {
    return;
  }

  const firstChoice = toOptionalObject(toArray(responseObj.choices)[0]);
  if (!firstChoice) {
    return;
  }

  const message = toOptionalObject(firstChoice.message);
  if (!message) {
    return;
  }

  cacheToolCallExtraContentFromOpenAIToolCalls(message.tool_calls);
}

function hydrateOpenAIRequestToolCalls(body: Record<string, unknown>): void {
  const messages = toArray(body.messages);
  for (const message of messages) {
    const messageObj = toOptionalObject(message);
    if (!messageObj) {
      continue;
    }

    for (const toolCall of toArray(messageObj.tool_calls)) {
      const toolCallObj = toOptionalObject(toolCall);
      if (!toolCallObj) {
        continue;
      }

      const existingExtraContent = normalizeToolCallExtraContent(toolCallObj);
      if (existingExtraContent !== undefined) {
        continue;
      }

      const toolCallId = toString(toolCallObj.id);
      if (toolCallId) {
        const cachedExtraContent = toolCallExtraContentById.get(toolCallId);
        if (cachedExtraContent !== undefined) {
          toolCallObj.extra_content = cachedExtraContent;
        }
      }
    }
  }
}

function createAnthropicErrorBody(message: string, type = 'api_error'): Record<string, unknown> {
  return {
    type: 'error',
    error: {
      type,
      message,
    },
  };
}

function extractErrorMessage(raw: string): string {
  if (!raw) {
    return 'Upstream API request failed';
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const errorObj = parsed.error;
    if (errorObj && typeof errorObj === 'object' && !Array.isArray(errorObj)) {
      const message = (errorObj as Record<string, unknown>).message;
      if (typeof message === 'string' && message) {
        return message;
      }
    }
    if (typeof parsed.message === 'string' && parsed.message) {
      return parsed.message;
    }
  } catch {
    // noop
  }

  return raw;
}

function buildUpstreamTargetUrls(baseURL: string): string[] {
  const primary = buildOpenAIChatCompletionsURL(baseURL);
  const urls = new Set<string>([primary]);

  if (primary.includes('generativelanguage.googleapis.com')) {
    if (primary.includes('/v1beta/openai/')) {
      urls.add(primary.replace('/v1beta/openai/', '/v1/openai/'));
    } else if (primary.includes('/v1/openai/')) {
      urls.add(primary.replace('/v1/openai/', '/v1beta/openai/'));
    }
  }

  return Array.from(urls);
}

function extractMaxTokensRange(errorMessage: string): { min: number; max: number } | null {
  if (!errorMessage) {
    return null;
  }

  const normalized = errorMessage.toLowerCase();
  if (!normalized.includes('max_tokens')) {
    return null;
  }

  const bracketMatch = /max_tokens[^\[]*\[\s*(\d+)\s*,\s*(\d+)\s*\]/i.exec(errorMessage);
  if (bracketMatch) {
    return {
      min: Number(bracketMatch[1]),
      max: Number(bracketMatch[2]),
    };
  }

  const betweenMatch = /max_tokens.*between\s+(\d+)\s*(?:and|-)\s*(\d+)/i.exec(errorMessage);
  if (betweenMatch) {
    return {
      min: Number(betweenMatch[1]),
      max: Number(betweenMatch[2]),
    };
  }

  return null;
}

function clampMaxTokensFromError(
  openAIRequest: Record<string, unknown>,
  errorMessage: string
): { changed: boolean; clampedTo?: number } {
  const currentMaxTokens = openAIRequest.max_tokens;
  if (typeof currentMaxTokens !== 'number' || !Number.isFinite(currentMaxTokens)) {
    return { changed: false };
  }

  const range = extractMaxTokensRange(errorMessage);
  if (!range) {
    return { changed: false };
  }

  const normalizedMin = Math.max(1, Math.floor(range.min));
  const normalizedMax = Math.max(normalizedMin, Math.floor(range.max));
  const nextValue = Math.min(Math.max(Math.floor(currentMaxTokens), normalizedMin), normalizedMax);

  if (nextValue === currentMaxTokens) {
    return { changed: false };
  }

  openAIRequest.max_tokens = nextValue;
  return { changed: true, clampedTo: nextValue };
}

function writeJSON(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function collectTextFragments(value: unknown, fragments: string[]): void {
  if (typeof value === 'string') {
    if (value) {
      fragments.push(value);
    }
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    fragments.push(String(value));
    return;
  }

  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextFragments(item, fragments);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectTextFragments(item, fragments);
    }
  }
}

function estimateAnthropicInputTokens(body: unknown): number {
  const fragments: string[] = [];
  collectTextFragments(body, fragments);
  const text = fragments.join('\n');
  if (!text) {
    return 1;
  }

  // Use a conservative approximation so token budgeting errs on the safe side.
  const estimated = Math.ceil(text.length / 3);
  return Math.max(1, Math.min(estimated, 4_000_000));
}

function buildAnthropicModelObject(id: string): Record<string, unknown> {
  return {
    type: 'model',
    id,
    display_name: id,
    created_at: '2026-01-01T00:00:00Z',
  };
}

function listProxyModels(config: OpenAICompatUpstreamConfig): string[] {
  const upstreamKind =
    config.upstreamKind
    || (config.provider === 'antigravity' ? 'antigravity' : 'openai');
  const ids = new Set<string>();

  if (upstreamKind === 'antigravity') {
    const configuredModel = (config.providerModelId || config.model || '').trim();
    if (configuredModel) {
      ids.add(configuredModel);
      const normalized = normalizeAntigravityModelId(configuredModel);
      if (normalized) {
        ids.add(normalized);
        ids.add(`google-antigravity/${normalized}`);
      }
    }

    // Claude SDK may probe with this fallback model during token estimation.
    ids.add('claude-haiku-4-5-20251001');
  } else if (config.model?.trim()) {
    ids.add(config.model.trim());
  }

  return Array.from(ids);
}

function parseUpstreamApiKeyPayload(rawApiKey: string): { token: string; projectId: string } {
  const parsed = parseOAuthApiKeyPayload(rawApiKey);
  return {
    token: parsed.token,
    projectId: getAntigravityProjectId(parsed.projectId),
  };
}

type PiAiRelayResult = {
  started: boolean;
  errorMessage?: string;
  retryableAuthError?: boolean;
};

function parseDataUrl(rawUrl: string): { mimeType: string; data: string } | null {
  const trimmed = rawUrl.trim();
  const matched = /^data:([^;,]+)?;base64,(.+)$/i.exec(trimmed);
  if (!matched) {
    return null;
  }

  const mimeType = matched[1]?.trim() || 'image/png';
  const data = matched[2]?.trim() || '';
  if (!data) {
    return null;
  }

  return { mimeType, data };
}

function normalizeOpenAIMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const partObj = toOptionalObject(part);
        if (!partObj) {
          return '';
        }
        if (partObj.type === 'text' && typeof partObj.text === 'string') {
          return partObj.text;
        }
        if (partObj.type === 'input_text' && typeof partObj.text === 'string') {
          return partObj.text;
        }
        return '';
      })
      .join('\n');
  }

  if (content === null || content === undefined) {
    return '';
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function normalizeOpenAIUserContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return normalizeOpenAIMessageText(content);
  }

  const parts: Array<Record<string, unknown>> = [];
  let hasImage = false;

  for (const part of content) {
    const partObj = toOptionalObject(part);
    if (!partObj) {
      continue;
    }

    const partType = toString(partObj.type);
    if ((partType === 'text' || partType === 'input_text') && typeof partObj.text === 'string') {
      parts.push({ type: 'text', text: partObj.text });
      continue;
    }

    if (partType === 'image_url') {
      const imageUrlObj = toOptionalObject(partObj.image_url);
      const rawUrl = toString(imageUrlObj?.url);
      if (!rawUrl) {
        continue;
      }

      const parsedImage = parseDataUrl(rawUrl);
      if (!parsedImage) {
        continue;
      }

      parts.push({
        type: 'image',
        data: parsedImage.data,
        mimeType: parsedImage.mimeType,
      });
      hasImage = true;
    }
  }

  if (!hasImage) {
    return parts
      .filter((part) => part.type === 'text')
      .map((part) => toString(part.text))
      .join('\n');
  }

  if (parts.length === 0) {
    return '';
  }

  return parts;
}

function extractToolCallThoughtSignature(toolCallObj: Record<string, unknown>): string | undefined {
  const extraContent = normalizeToolCallExtraContent(toolCallObj);
  const extraObj = toOptionalObject(extraContent);
  const googleObj = toOptionalObject(extraObj?.google);
  const nestedSignature = toString(googleObj?.thought_signature);
  if (nestedSignature) {
    return nestedSignature;
  }

  const functionObj = toOptionalObject(toolCallObj.function);
  const functionSignature = toString(functionObj?.thought_signature);
  if (functionSignature) {
    return functionSignature;
  }

  return undefined;
}

function isValidThoughtSignature(signature: string | undefined): signature is string {
  if (!signature) {
    return false;
  }
  if (signature.length % 4 !== 0) {
    return false;
  }
  return BASE64_THOUGHT_SIGNATURE_RE.test(signature);
}

function normalizeToolChoice(rawToolChoice: unknown): 'auto' | 'none' | 'any' | undefined {
  if (rawToolChoice === 'auto' || rawToolChoice === 'none' || rawToolChoice === 'any') {
    return rawToolChoice;
  }

  if (rawToolChoice === 'required') {
    return 'any';
  }

  const toolChoiceObj = toOptionalObject(rawToolChoice);
  if (!toolChoiceObj) {
    return undefined;
  }

  const toolChoiceType = toString(toolChoiceObj.type);
  if (toolChoiceType === 'none' || toolChoiceType === 'auto') {
    return toolChoiceType;
  }
  if (toolChoiceType === 'required' || toolChoiceType === 'function') {
    return 'any';
  }

  return undefined;
}

const UNSUPPORTED_CLOUD_CODE_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  '$defs',
  'definitions',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'unevaluatedProperties',
  'patternProperties',
  'contains',
  'minContains',
  'maxContains',
  'dependentSchemas',
  'dependentRequired',
  'if',
  'then',
  'else',
  'not',
  'allOf',
  'oneOf',
  'const',
  'examples',
]);

function sanitizeSchemaForCloudCodeAssist(rawSchema: unknown): Record<string, unknown> {
  const source = toOptionalObject(rawSchema) || {};
  const sanitized: Record<string, unknown> = {};

  const type = toString(source.type);
  if (type) {
    sanitized.type = type;
  }

  const description = toString(source.description);
  if (description) {
    sanitized.description = description;
  }

  if (Array.isArray(source.required)) {
    sanitized.required = source.required.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }

  if (Array.isArray(source.enum)) {
    sanitized.enum = source.enum.filter((item) => {
      const itemType = typeof item;
      return itemType === 'string' || itemType === 'number' || itemType === 'boolean' || item === null;
    });
  }

  const numericKeys = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const;
  for (const key of numericKeys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = value;
    }
  }

  const properties = toOptionalObject(source.properties);
  if (properties) {
    const sanitizedProperties: Record<string, unknown> = {};
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      sanitizedProperties[propertyName] = sanitizeSchemaForCloudCodeAssist(propertySchema);
    }
    sanitized.properties = sanitizedProperties;
    if (!sanitized.type) {
      sanitized.type = 'object';
    }
  }

  if (source.items !== undefined) {
    const itemsSchema = Array.isArray(source.items) ? source.items[0] : source.items;
    sanitized.items = sanitizeSchemaForCloudCodeAssist(itemsSchema);
    if (!sanitized.type) {
      sanitized.type = 'array';
    }
  }

  const passthroughKeys = ['format', 'nullable', 'default', 'example'] as const;
  for (const key of passthroughKeys) {
    const value = source[key];
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }

  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('$') || UNSUPPORTED_CLOUD_CODE_SCHEMA_KEYS.has(key)) {
      continue;
    }
    if (key in sanitized) {
      continue;
    }
    if (key === 'anyOf' && Array.isArray(value)) {
      sanitized.anyOf = value.map((item) => sanitizeSchemaForCloudCodeAssist(item));
      continue;
    }
  }

  if (!sanitized.type) {
    sanitized.type = 'object';
  }

  return sanitized;
}

function buildPiAiModel(modelId: string, baseURL: string): Record<string, unknown> {
  const supportsImage = !modelId.includes('gpt-oss');
  return {
    id: modelId,
    name: modelId,
    api: 'google-gemini-cli',
    provider: 'google-antigravity',
    baseUrl: baseURL.trim(),
    reasoning: true,
    input: supportsImage ? ['text', 'image'] : ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: DEFAULT_PI_MODEL_CONTEXT_WINDOW,
    maxTokens: DEFAULT_PI_MODEL_MAX_TOKENS,
  };
}

function buildPiAiContextFromOpenAIRequest(
  openAIRequest: Record<string, unknown>,
  modelId: string
): {
  context: Record<string, unknown>;
  options: Record<string, unknown>;
} {
  const normalizedModelId = modelId.toLowerCase();
  const isGemini3Model = normalizedModelId.includes('gemini-3');
  const systemPrompts: string[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const knownToolNameById = new Map<string, string>();

  const sourceMessages = toArray(openAIRequest.messages);
  for (const item of sourceMessages) {
    const itemObj = toOptionalObject(item);
    if (!itemObj) {
      continue;
    }

    const role = toString(itemObj.role);
    const timestamp = Date.now();

    if (role === 'system') {
      const text = normalizeOpenAIMessageText(itemObj.content).trim();
      if (text) {
        systemPrompts.push(text);
      }
      continue;
    }

    if (role === 'user') {
      const content = normalizeOpenAIUserContent(itemObj.content);
      if ((typeof content === 'string' && !content.trim())
        || (Array.isArray(content) && content.length === 0)) {
        continue;
      }

      messages.push({
        role: 'user',
        content,
        timestamp,
      });
      continue;
    }

    if (role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      const textContent = normalizeOpenAIMessageText(itemObj.content);
      if (textContent.trim()) {
        blocks.push({
          type: 'text',
          text: textContent,
        });
      }

      const reasoningContent = toString(itemObj.reasoning_content) || toString(itemObj.reasoning);
      if (reasoningContent.trim()) {
        blocks.push({
          type: 'thinking',
          thinking: reasoningContent,
        });
      }

      for (const rawToolCall of toArray(itemObj.tool_calls)) {
        const toolCallObj = toOptionalObject(rawToolCall);
        if (!toolCallObj) {
          continue;
        }

        const functionObj = toOptionalObject(toolCallObj.function);
        const toolCallId = toString(toolCallObj.id) || `tool_call_${Date.now()}`;
        const toolCallName = toString(functionObj?.name) || 'tool';
        const toolCallArgumentsRaw = toString(functionObj?.arguments) || '{}';
        let toolCallArguments: Record<string, unknown> = {};

        try {
          const parsed = JSON.parse(toolCallArgumentsRaw);
          toolCallArguments = toOptionalObject(parsed) || {};
        } catch {
          toolCallArguments = {};
        }

        const block: Record<string, unknown> = {
          type: 'toolCall',
          id: toolCallId,
          name: toolCallName,
          arguments: toolCallArguments,
        };

        const thoughtSignature = extractToolCallThoughtSignature(toolCallObj);
        if (isGemini3Model && !isValidThoughtSignature(thoughtSignature)) {
          // Gemini 3 history replay without valid thought signatures is rewritten by pi-ai
          // into noisy "Historical context..." text, which pollutes follow-up turns.
          // Skip those legacy tool-call blocks and keep the turn stable.
          continue;
        }
        if (thoughtSignature) {
          block.thoughtSignature = thoughtSignature;
        }

        blocks.push(block);
        knownToolNameById.set(toolCallId, toolCallName);
      }

      if (blocks.length === 0) {
        continue;
      }

      messages.push({
        role: 'assistant',
        content: blocks,
        api: 'google-gemini-cli',
        provider: 'google-antigravity',
        model: modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: 'stop',
        timestamp,
      });
      continue;
    }

    if (role === 'tool') {
      const toolCallId = toString(itemObj.tool_call_id);
      if (!toolCallId) {
        continue;
      }
      if (isGemini3Model && !knownToolNameById.has(toolCallId)) {
        continue;
      }

      const toolName = toString(itemObj.name) || knownToolNameById.get(toolCallId) || 'tool';
      const toolResultText = normalizeOpenAIMessageText(itemObj.content);
      messages.push({
        role: 'toolResult',
        toolCallId,
        toolName,
        content: [{
          type: 'text',
          text: toolResultText || '',
        }],
        isError: false,
        timestamp,
      });
      continue;
    }
  }

  const tools = toArray(openAIRequest.tools)
    .map((tool) => {
      const toolObj = toOptionalObject(tool);
      const functionObj = toOptionalObject(toolObj?.function);
      const name = toString(functionObj?.name);
      if (!name) {
        return null;
      }

      return {
        name,
        description: toString(functionObj?.description),
        parameters: sanitizeSchemaForCloudCodeAssist(functionObj?.parameters),
      };
    })
    .filter((tool): tool is {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    } => Boolean(tool));

  const context: Record<string, unknown> = {
    messages,
  };
  if (systemPrompts.length > 0) {
    context.systemPrompt = systemPrompts.join('\n\n');
  }
  if (tools.length > 0) {
    context.tools = tools;
  }

  const options: Record<string, unknown> = {};
  if (typeof openAIRequest.max_tokens === 'number' && Number.isFinite(openAIRequest.max_tokens)) {
    options.maxTokens = openAIRequest.max_tokens;
  }
  if (typeof openAIRequest.temperature === 'number' && Number.isFinite(openAIRequest.temperature)) {
    options.temperature = openAIRequest.temperature;
  }
  const toolChoice = normalizeToolChoice(openAIRequest.tool_choice);
  if (toolChoice) {
    options.toolChoice = toolChoice;
  }

  return { context, options };
}

function mapPiAiStopReasonToOpenAIFinishReason(rawReason: unknown): 'stop' | 'length' | 'tool_calls' {
  const reason = toString(rawReason);
  if (reason === 'toolUse') {
    return 'tool_calls';
  }
  if (reason === 'length') {
    return 'length';
  }
  return 'stop';
}

function extractPiAiEventErrorMessage(eventObj: Record<string, unknown>): string {
  const errorObj = toOptionalObject(eventObj.error);
  const fromErrorField = toString(errorObj?.errorMessage) || toString(errorObj?.message);
  if (fromErrorField) {
    return fromErrorField;
  }
  const fromEventField = toString(eventObj.message);
  if (fromEventField) {
    return fromEventField;
  }
  return 'Upstream API request failed';
}

function isRetryableAuthError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return normalized.includes('401')
    || normalized.includes('unauthorized')
    || normalized.includes('re-authenticate')
    || normalized.includes('oauth')
    || normalized.includes('expired token');
}

function buildOpenAIResponseFromPiAiMessage(
  messageObj: Record<string, unknown>,
  modelId: string
): Record<string, unknown> {
  const contentBlocks = toArray(messageObj.content);
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const block of contentBlocks) {
    const blockObj = toOptionalObject(block);
    if (!blockObj) {
      continue;
    }

    const blockType = toString(blockObj.type);
    if (blockType === 'text') {
      const text = toString(blockObj.text);
      if (text) {
        textParts.push(text);
      }
      continue;
    }

    if (blockType === 'thinking') {
      const thinking = toString(blockObj.thinking);
      if (thinking) {
        thinkingParts.push(thinking);
      }
      continue;
    }

    if (blockType === 'toolCall') {
      const toolCallId = toString(blockObj.id) || `tool_call_${Date.now()}`;
      const toolCallName = toString(blockObj.name) || 'tool';
      const argumentsObj = toOptionalObject(blockObj.arguments) || {};
      const toolCall: Record<string, unknown> = {
        id: toolCallId,
        type: 'function',
        function: {
          name: toolCallName,
          arguments: JSON.stringify(argumentsObj),
        },
      };

      const thoughtSignature = toString(blockObj.thoughtSignature);
      if (thoughtSignature) {
        toolCall.extra_content = {
          google: {
            thought_signature: thoughtSignature,
          },
        };
      }

      toolCalls.push(toolCall);
    }
  }

  const openAIMessage: Record<string, unknown> = {
    role: 'assistant',
    content: textParts.join(''),
  };
  if (thinkingParts.length > 0) {
    openAIMessage.reasoning_content = thinkingParts.join('');
  }
  if (toolCalls.length > 0) {
    openAIMessage.tool_calls = toolCalls;
  }

  const usageObj = toOptionalObject(messageObj.usage) || {};
  const promptTokens = Number(usageObj.input) || 0;
  const completionTokens = Number(usageObj.output) || 0;

  return {
    id: `chatcmpl-${Date.now()}`,
    model: modelId,
    choices: [{
      index: 0,
      message: openAIMessage,
      finish_reason: mapPiAiStopReasonToOpenAIFinishReason(messageObj.stopReason),
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

async function collectPiAiFinalMessage(piStream: AsyncIterable<unknown>): Promise<Record<string, unknown>> {
  let finalMessage: Record<string, unknown> | null = null;

  for await (const rawEvent of piStream) {
    const eventObj = toOptionalObject(rawEvent);
    if (!eventObj) {
      continue;
    }

    const eventType = toString(eventObj.type);
    if (eventType === 'error') {
      throw new Error(extractPiAiEventErrorMessage(eventObj));
    }
    if (eventType === 'done') {
      finalMessage = toOptionalObject(eventObj.message) || null;
    }
  }

  if (!finalMessage) {
    throw new Error('Cloud Code Assist API returned an empty response');
  }

  return finalMessage;
}

async function relayPiAiStreamAsAnthropicSSE(
  piStream: AsyncIterable<unknown>,
  res: http.ServerResponse,
  modelId: string
): Promise<PiAiRelayResult> {
  let started = false;
  const state = createStreamState();

  const ensureHeaders = () => {
    if (started) {
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    started = true;
  };

  const flushMessageStop = () => {
    if (!started || state.hasMessageStop || !state.hasMessageStart) {
      return;
    }
    closeCurrentBlockIfNeeded(res, state);
    emitSSE(res, 'message_stop', {
      type: 'message_stop',
    });
    state.hasMessageStop = true;
  };

  for await (const rawEvent of piStream) {
    const eventObj = toOptionalObject(rawEvent);
    if (!eventObj) {
      continue;
    }

    const eventType = toString(eventObj.type);
    if (eventType === 'error') {
      const errorMessage = extractPiAiEventErrorMessage(eventObj);
      if (!started) {
        return {
          started: false,
          errorMessage,
          retryableAuthError: isRetryableAuthError(errorMessage),
        };
      }
      emitSSE(res, 'error', createAnthropicErrorBody(errorMessage));
      flushMessageStop();
      res.end();
      return {
        started: true,
        errorMessage,
      };
    }

    ensureHeaders();

    if (eventType === 'start') {
      ensureMessageStart(res, state, {
        id: `chatcmpl-${Date.now()}`,
        model: modelId,
      });
      continue;
    }

    if (eventType === 'thinking_delta') {
      ensureMessageStart(res, state, {
        id: `chatcmpl-${Date.now()}`,
        model: modelId,
      });
      ensureThinkingBlock(res, state);
      emitSSE(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.contentIndex,
        delta: {
          type: 'thinking_delta',
          thinking: toString(eventObj.delta),
        },
      });
      continue;
    }

    if (eventType === 'text_delta') {
      ensureMessageStart(res, state, {
        id: `chatcmpl-${Date.now()}`,
        model: modelId,
      });
      ensureTextBlock(res, state);
      emitSSE(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.contentIndex,
        delta: {
          type: 'text_delta',
          text: toString(eventObj.delta),
        },
      });
      continue;
    }

    if (eventType === 'toolcall_end') {
      ensureMessageStart(res, state, {
        id: `chatcmpl-${Date.now()}`,
        model: modelId,
      });
      const toolCallObj = toOptionalObject(eventObj.toolCall) || {};
      const toolIndexRaw = eventObj.contentIndex;
      const toolIndex = (
        typeof toolIndexRaw === 'number'
        && Number.isFinite(toolIndexRaw)
      ) ? toolIndexRaw : Object.keys(state.toolCalls).length;

      const toolCallState: ToolCallState = {
        id: toString(toolCallObj.id) || `tool_call_${toolIndex}`,
        name: toString(toolCallObj.name) || 'tool',
      };

      const thoughtSignature = toString(toolCallObj.thoughtSignature);
      if (thoughtSignature) {
        toolCallState.extraContent = {
          google: {
            thought_signature: thoughtSignature,
          },
        };
      }

      state.toolCalls[toolIndex] = {
        ...(state.toolCalls[toolIndex] || {}),
        ...toolCallState,
      };
      ensureToolUseBlock(res, state, toolIndex, state.toolCalls[toolIndex]);

      const toolCallArgsObj = toOptionalObject(toolCallObj.arguments) || {};
      emitSSE(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.contentIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(toolCallArgsObj),
        },
      });
      continue;
    }

    if (eventType === 'done') {
      ensureMessageStart(res, state, {
        id: `chatcmpl-${Date.now()}`,
        model: modelId,
      });
      const messageObj = toOptionalObject(eventObj.message) || {};
      const usageObj = toOptionalObject(messageObj.usage) || {};
      const finishReason = mapPiAiStopReasonToOpenAIFinishReason(eventObj.reason);
      emitMessageDelta(res, state, finishReason, {
        id: `chatcmpl-${Date.now()}`,
        model: modelId,
        usage: {
          prompt_tokens: Number(usageObj.input) || 0,
          completion_tokens: Number(usageObj.output) || 0,
        },
      });
      continue;
    }
  }

  if (!started) {
    return {
      started: false,
      errorMessage: 'Cloud Code Assist API returned an empty response',
      retryableAuthError: false,
    };
  }

  flushMessageStop();
  res.end();
  return {
    started: true,
  };
}

async function handleAntigravityRequestViaPiAi(
  openAIRequest: Record<string, unknown>,
  stream: boolean,
  res: http.ServerResponse,
  config: OpenAICompatUpstreamConfig
): Promise<void> {
  const requestedModel = typeof openAIRequest.model === 'string'
    ? openAIRequest.model
    : config.providerModelId || config.model;
  const normalizedModelId = normalizeAntigravityModelId(requestedModel);
  const piModel = buildPiAiModel(normalizedModelId, config.baseURL);
  const { context, options } = buildPiAiContextFromOpenAIRequest(openAIRequest, normalizedModelId);
  const piAi = await loadPiAi();

  const resolveApiKey = async (forceRefresh: boolean): Promise<string> => {
    const resolvedRawApiKey = config.resolveAuthApiKey
      ? await config.resolveAuthApiKey(forceRefresh)
      : config.apiKey;
    if (!resolvedRawApiKey) {
      throw new Error('Antigravity OAuth is not connected. Please login first.');
    }

    const parsedPayload = parseUpstreamApiKeyPayload(resolvedRawApiKey);
    return JSON.stringify({
      token: parsedPayload.token,
      projectId: parsedPayload.projectId,
    });
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const forceRefresh = attempt > 0;
    const requestTimeoutMs = Number(process.env.LOBSTER_ANTIGRAVITY_REQUEST_TIMEOUT_MS)
      || DEFAULT_ANTIGRAVITY_REQUEST_TIMEOUT_MS;
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => {
      abortController.abort(new Error(`timeout-${requestTimeoutMs}`));
    }, requestTimeoutMs);

    try {
      const apiKeyPayload = await resolveApiKey(forceRefresh);
      const streamOptions: Record<string, unknown> = {
        apiKey: apiKeyPayload,
        ...options,
        signal: abortController.signal,
      };

      const piStream = piAi.streamGoogleGeminiCli(
        piModel as never,
        context as never,
        streamOptions as never
      );

      if (stream) {
        const relay = await relayPiAiStreamAsAnthropicSSE(piStream, res, normalizedModelId);
        if (!relay.started && relay.errorMessage) {
          if (relay.retryableAuthError && attempt === 0 && config.resolveAuthApiKey) {
            lastError = new Error(relay.errorMessage);
            continue;
          }
          throw new Error(relay.errorMessage);
        }
        return;
      }

      const finalMessage = await collectPiAiFinalMessage(piStream);
      const openAIResponse = buildOpenAIResponseFromPiAiMessage(finalMessage, normalizedModelId);
      const anthropicResponse = openAIToAnthropic(openAIResponse);
      writeJSON(res, 200, anthropicResponse);
      return;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const isTimedOut = abortController.signal.aborted
        && (`${rawMessage}`.includes(`timeout-${requestTimeoutMs}`)
          || rawMessage === 'Request was aborted');
      const message = isTimedOut
        ? `Antigravity request timeout after ${Math.floor(requestTimeoutMs / 1000)}s`
        : rawMessage;
      if (attempt === 0 && config.resolveAuthApiKey && isRetryableAuthError(message)) {
        lastError = error instanceof Error ? error : new Error(message);
        continue;
      }
      lastError = error instanceof Error ? error : new Error(message);
      break;
    } finally {
      clearTimeout(abortTimer);
    }
  }

  throw lastError || new Error('Antigravity request failed');
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const decodeBody = (raw: Buffer): string => {
      if (raw.length === 0) {
        return '';
      }

      const collectStringValues = (input: unknown, out: string[]): void => {
        if (typeof input === 'string') {
          out.push(input);
          return;
        }
        if (Array.isArray(input)) {
          for (const item of input) collectStringValues(item, out);
          return;
        }
        if (input && typeof input === 'object') {
          for (const value of Object.values(input as Record<string, unknown>)) {
            collectStringValues(value, out);
          }
        }
      };

      const scoreDecodedJsonText = (text: string): number => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return -10000;
        }

        const values: string[] = [];
        collectStringValues(parsed, values);
        const joined = values.join('\n');
        if (!joined) return 0;

        const cjkCount = (joined.match(/[\u3400-\u9FFF]/g) || []).length;
        const replacementCount = (joined.match(/\uFFFD/g) || []).length;
        const mojibakeCount = (joined.match(/[ÃÂÐÑØÙÞæçèéêëìíîïðñòóôõöøùúûüýþÿ]/g) || []).length;
        const nonAsciiCount = (joined.match(/[^\x00-\x7F]/g) || []).length;

        return cjkCount * 4 + nonAsciiCount - replacementCount * 8 - mojibakeCount * 3;
      };

      // BOM-aware decoding first.
      if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
        return new TextDecoder('utf-8', { fatal: false }).decode(raw.subarray(3));
      }
      if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
        return new TextDecoder('utf-16le', { fatal: false }).decode(raw.subarray(2));
      }
      if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
        return new TextDecoder('utf-16be', { fatal: false }).decode(raw.subarray(2));
      }

      // Try strict UTF-8 first.
      let utf8Decoded: string | null = null;
      try {
        utf8Decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        utf8Decoded = null;
      }

      // On Windows local shells (especially Git Bash/curl paths), requests
      // may be emitted in system codepage instead of UTF-8.
      if (process.platform === 'win32') {
        let gbDecoded: string | null = null;
        try {
          gbDecoded = new TextDecoder('gb18030', { fatal: true }).decode(raw);
        } catch {
          gbDecoded = null;
        }

        if (utf8Decoded && gbDecoded) {
          const utf8Score = scoreDecodedJsonText(utf8Decoded);
          const gbScore = scoreDecodedJsonText(gbDecoded);
          if (gbScore > utf8Score) {
            console.warn(`[CoworkProxy] Decoded request body using gb18030 (score ${gbScore} > utf8 ${utf8Score})`);
            return gbDecoded;
          }
          return utf8Decoded;
        }

        if (gbDecoded && !utf8Decoded) {
          console.warn('[CoworkProxy] Decoded request body using gb18030 fallback');
          return gbDecoded;
        }
      }

      if (utf8Decoded) {
        return utf8Decoded;
      }

      return new TextDecoder('utf-8', { fatal: false }).decode(raw);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > 20 * 1024 * 1024) {
        fail(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const body = decodeBody(Buffer.concat(chunks));
      resolve(body);
    });

    req.on('error', (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function createStreamState(): StreamState {
  return {
    messageId: null,
    model: null,
    contentIndex: 0,
    currentBlockType: null,
    activeToolIndex: null,
    hasMessageStart: false,
    hasMessageStop: false,
    toolCalls: {},
  };
}

function emitSSE(res: http.ServerResponse, event: string, data: Record<string, unknown>): void {
  res.write(formatSSEEvent(event, data));
}

function closeCurrentBlockIfNeeded(res: http.ServerResponse, state: StreamState): void {
  if (!state.currentBlockType) {
    return;
  }

  emitSSE(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: state.contentIndex,
  });

  state.contentIndex += 1;
  state.currentBlockType = null;
  state.activeToolIndex = null;
}

function ensureMessageStart(
  res: http.ServerResponse,
  state: StreamState,
  chunk: OpenAIStreamChunk
): void {
  if (state.hasMessageStart) {
    return;
  }

  state.messageId = chunk.id ?? state.messageId ?? `chatcmpl-${Date.now()}`;
  state.model = chunk.model ?? state.model ?? 'unknown';

  emitSSE(res, 'message_start', {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      model: state.model,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  });

  state.hasMessageStart = true;
}

function ensureThinkingBlock(res: http.ServerResponse, state: StreamState): void {
  if (state.currentBlockType === 'thinking') {
    return;
  }

  closeCurrentBlockIfNeeded(res, state);

  emitSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: {
      type: 'thinking',
      thinking: '',
    },
  });

  state.currentBlockType = 'thinking';
}

function ensureTextBlock(res: http.ServerResponse, state: StreamState): void {
  if (state.currentBlockType === 'text') {
    return;
  }

  closeCurrentBlockIfNeeded(res, state);

  emitSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: {
      type: 'text',
      text: '',
    },
  });

  state.currentBlockType = 'text';
}

function ensureToolUseBlock(
  res: http.ServerResponse,
  state: StreamState,
  index: number,
  toolCall: ToolCallState
): void {
  const resolvedId = toolCall.id || `tool_call_${index}`;
  const resolvedName = toolCall.name || 'tool';

  if (state.currentBlockType === 'tool_use' && state.activeToolIndex === index) {
    return;
  }

  closeCurrentBlockIfNeeded(res, state);

  const contentBlock: Record<string, unknown> = {
    type: 'tool_use',
    id: resolvedId,
    name: resolvedName,
  };

  if (toolCall.extraContent !== undefined) {
    contentBlock.extra_content = toolCall.extraContent;
  }

  emitSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: contentBlock,
  });

  state.currentBlockType = 'tool_use';
  state.activeToolIndex = index;
}

function emitMessageDelta(
  res: http.ServerResponse,
  state: StreamState,
  finishReason: string | null | undefined,
  chunk: OpenAIStreamChunk
): void {
  closeCurrentBlockIfNeeded(res, state);

  emitSSE(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: mapStopReason(finishReason),
      stop_sequence: null,
    },
    usage: {
      input_tokens: chunk.usage?.prompt_tokens ?? 0,
      output_tokens: chunk.usage?.completion_tokens ?? 0,
    },
  });
}

function processOpenAIChunk(
  res: http.ServerResponse,
  state: StreamState,
  chunk: OpenAIStreamChunk
): void {
  ensureMessageStart(res, state, chunk);

  const choice = chunk.choices?.[0];
  if (!choice) {
    return;
  }

  const delta = choice.delta;
  const deltaReasoning = delta?.reasoning_content ?? delta?.reasoning;

  if (deltaReasoning) {
    ensureThinkingBlock(res, state);
    emitSSE(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: state.contentIndex,
      delta: {
        type: 'thinking_delta',
        thinking: deltaReasoning,
      },
    });
  }

  if (delta?.content) {
    ensureTextBlock(res, state);
    emitSSE(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: state.contentIndex,
      delta: {
        type: 'text_delta',
        text: delta.content,
      },
    });
  }

  if (Array.isArray(delta?.tool_calls)) {
    for (const item of delta.tool_calls) {
      const toolIndex = item.index ?? 0;
      const existing = state.toolCalls[toolIndex] ?? {};
      const normalizedExtraContent = normalizeToolCallExtraContent(
        item as unknown as Record<string, unknown>
      );
      if (normalizedExtraContent !== undefined) {
        existing.extraContent = normalizedExtraContent;
      }

      if (item.id) {
        existing.id = item.id;
      }
      if (item.function?.name) {
        existing.name = item.function.name;
      }
      state.toolCalls[toolIndex] = existing;
      if (existing.id && existing.extraContent !== undefined) {
        cacheToolCallExtraContent(existing.id, existing.extraContent);
      }

      if (item.function?.name) {
        ensureToolUseBlock(res, state, toolIndex, existing);
      }

      if (item.function?.arguments) {
        ensureToolUseBlock(res, state, toolIndex, existing);
        emitSSE(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.contentIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: item.function.arguments,
          },
        });
      }
    }
  }

  if (choice.finish_reason) {
    emitMessageDelta(res, state, choice.finish_reason, chunk);
  }
}

async function handleStreamResponse(
  upstreamResponse: Response,
  res: http.ServerResponse
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (!upstreamResponse.body) {
    emitSSE(res, 'error', createAnthropicErrorBody('Upstream returned empty stream', 'stream_error'));
    res.end();
    return;
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const state = createStreamState();

  let buffer = '';

  const flushDone = () => {
    if (!state.hasMessageStart) {
      return;
    }
    if (!state.hasMessageStop) {
      closeCurrentBlockIfNeeded(res, state);
      emitSSE(res, 'message_stop', {
        type: 'message_stop',
      });
      state.hasMessageStop = true;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let splitIndex = buffer.indexOf('\n\n');
    while (splitIndex !== -1) {
      const packet = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);

      const lines = packet.split(/\r?\n/);
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      const payload = dataLines.join('\n');
      if (!payload) {
        splitIndex = buffer.indexOf('\n\n');
        continue;
      }

      if (payload === '[DONE]') {
        flushDone();
        splitIndex = buffer.indexOf('\n\n');
        continue;
      }

      try {
        const parsed = JSON.parse(payload) as OpenAIStreamChunk;
        processOpenAIChunk(res, state, parsed);
      } catch {
        // Ignore malformed stream chunks.
      }

      splitIndex = buffer.indexOf('\n\n');
    }
  }

  flushDone();
  res.end();
}

async function handleCreateScheduledTask(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }

  let body: string;
  try {
    body = await readRequestBody(req);
  } catch {
    writeJSON(res, 400, { success: false, error: 'Invalid request body' } as any);
    return;
  }

  let input: any;
  try {
    input = JSON.parse(body);
  } catch {
    writeJSON(res, 400, { success: false, error: 'Invalid JSON' } as any);
    return;
  }

  // Validate required fields
  if (!input.name?.trim()) {
    writeJSON(res, 400, { success: false, error: 'Missing required field: name' } as any);
    return;
  }
  if (!input.prompt?.trim()) {
    writeJSON(res, 400, { success: false, error: 'Missing required field: prompt' } as any);
    return;
  }
  if (!input.schedule?.type) {
    writeJSON(res, 400, { success: false, error: 'Missing required field: schedule.type' } as any);
    return;
  }
  if (!['at', 'interval', 'cron'].includes(input.schedule.type)) {
    writeJSON(res, 400, { success: false, error: 'Invalid schedule type. Must be: at, interval, cron' } as any);
    return;
  }
  if (input.schedule.type === 'cron' && !input.schedule.expression) {
    writeJSON(res, 400, { success: false, error: 'Cron schedule requires expression field' } as any);
    return;
  }
  if (input.schedule.type === 'at' && !input.schedule.datetime) {
    writeJSON(res, 400, { success: false, error: 'At schedule requires datetime field' } as any);
    return;
  }

  // Validate: "at" type must be in the future
  if (input.schedule.type === 'at' && input.schedule.datetime) {
    const targetMs = new Date(input.schedule.datetime).getTime();
    if (targetMs <= Date.now()) {
      writeJSON(res, 400, { success: false, error: 'Execution time must be in the future for one-time (at) tasks' } as any);
      return;
    }
  }

  // Validate: expiresAt must not be in the past
  if (input.expiresAt) {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (input.expiresAt <= todayStr) {
      writeJSON(res, 400, { success: false, error: 'Expiration date must be in the future' } as any);
      return;
    }
  }

  // Build ScheduledTaskInput with defaults
  const taskInput: ScheduledTaskInput = {
    name: input.name.trim(),
    description: input.description || '',
    schedule: input.schedule,
    prompt: input.prompt.trim(),
    workingDirectory: normalizeScheduledTaskWorkingDirectory(input.workingDirectory),
    systemPrompt: input.systemPrompt || '',
    executionMode: input.executionMode || 'auto',
    expiresAt: input.expiresAt || null,
    notifyPlatforms: input.notifyPlatforms || [],
    enabled: input.enabled !== false,
  };

  try {
    const task = scheduledTaskDeps.getScheduledTaskStore().createTask(taskInput);
    scheduledTaskDeps.getScheduler().reschedule();

    // Notify renderer to refresh task list
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('scheduledTask:statusUpdate', {
        taskId: task.id,
        state: task.state,
      });
    }

    console.log(`[CoworkProxy] Scheduled task created via API: ${task.id} "${task.name}"`);
    writeJSON(res, 201, { success: true, task } as any);
  } catch (err: any) {
    console.error('[CoworkProxy] Failed to create scheduled task:', err);
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();
  const url = new URL(req.url || '/', `http://${LOCAL_HOST}`);

  // Scheduled task creation API
  if (method === 'POST' && url.pathname === '/api/scheduled-tasks') {
    await handleCreateScheduledTask(req, res);
    return;
  }

  if (method === 'GET' && (url.pathname === '/v1/models' || url.pathname.startsWith('/v1/models/'))) {
    if (!upstreamConfig) {
      writeJSON(
        res,
        503,
        createAnthropicErrorBody('OpenAI compatibility proxy is not configured', 'service_unavailable')
      );
      return;
    }

    const models = listProxyModels(upstreamConfig).map((id) => buildAnthropicModelObject(id));
    if (url.pathname === '/v1/models') {
      writeJSON(res, 200, {
        type: 'list',
        data: models,
        first_id: models[0] ? toString(models[0].id) : null,
        has_more: false,
      });
      return;
    }

    const modelId = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
    const matched = models.find((item) => toString(item.id) === modelId);
    if (!matched) {
      writeJSON(res, 404, createAnthropicErrorBody('Model not found', 'not_found_error'));
      return;
    }

    writeJSON(res, 200, matched);
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
    let requestBodyRaw = '';
    try {
      requestBodyRaw = await readRequestBody(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body';
      writeJSON(res, 400, createAnthropicErrorBody(message, 'invalid_request_error'));
      return;
    }

    let parsedRequestBody: unknown;
    try {
      parsedRequestBody = JSON.parse(requestBodyRaw);
    } catch {
      writeJSON(res, 400, createAnthropicErrorBody('Request body must be valid JSON', 'invalid_request_error'));
      return;
    }

    const inputTokens = estimateAnthropicInputTokens(parsedRequestBody);
    writeJSON(res, 200, {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    return;
  }

  if (method !== 'POST' || url.pathname !== '/v1/messages') {
    writeJSON(res, 404, createAnthropicErrorBody('Not found', 'not_found_error'));
    return;
  }

  if (!upstreamConfig) {
    writeJSON(
      res,
      503,
      createAnthropicErrorBody('OpenAI compatibility proxy is not configured', 'service_unavailable')
    );
    return;
  }

  let requestBodyRaw = '';
  try {
    requestBodyRaw = await readRequestBody(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request body';
    writeJSON(res, 400, createAnthropicErrorBody(message, 'invalid_request_error'));
    return;
  }

  let parsedRequestBody: unknown;
  try {
    parsedRequestBody = JSON.parse(requestBodyRaw);
  } catch {
    writeJSON(res, 400, createAnthropicErrorBody('Request body must be valid JSON', 'invalid_request_error'));
    return;
  }

  const openAIRequest = anthropicToOpenAI(parsedRequestBody);
  if (!openAIRequest.model) {
    openAIRequest.model = upstreamConfig.model;
  }
  const upstreamKind =
    upstreamConfig.upstreamKind
    || (upstreamConfig.provider === 'antigravity' ? 'antigravity' : 'openai');

  if (upstreamKind === 'antigravity') {
    const requestedModel = typeof openAIRequest.model === 'string'
      ? openAIRequest.model
      : upstreamConfig.providerModelId || upstreamConfig.model;
    openAIRequest.model = normalizeAntigravityModelId(requestedModel);
  }

  hydrateOpenAIRequestToolCalls(openAIRequest);

  const stream = Boolean(openAIRequest.stream);

  if (upstreamKind === 'antigravity') {
    try {
      await handleAntigravityRequestViaPiAi(openAIRequest, stream, res, upstreamConfig);
      lastProxyError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Antigravity request failed';
      lastProxyError = message;
      const statusCode = isRetryableAuthError(message) ? 401 : 502;
      writeJSON(
        res,
        statusCode,
        createAnthropicErrorBody(
          message,
          statusCode === 401 ? 'authentication_error' : 'api_error'
        )
      );
    }
    return;
  }

  const headersBase: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const authHeaders: Record<string, string> = {};
  const applyUpstreamAuthHeaders = async (): Promise<void> => {
    Object.keys(authHeaders).forEach((key) => delete authHeaders[key]);

    if (upstreamConfig.apiKey) {
      authHeaders.Authorization = `Bearer ${upstreamConfig.apiKey}`;
    }
  };

  try {
    await applyUpstreamAuthHeaders();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resolve upstream auth headers';
    lastProxyError = message;
    writeJSON(res, 401, createAnthropicErrorBody(message, 'authentication_error'));
    return;
  }

  const targetURLs = buildUpstreamTargetUrls(upstreamConfig.baseURL);
  let currentTargetURL = targetURLs[0];

  const sendUpstreamRequest = async (
    payload: Record<string, unknown>,
    targetURL: string
  ): Promise<Response> => {
    currentTargetURL = targetURL;
    return session.defaultSession.fetch(targetURL, {
      method: 'POST',
      headers: {
        ...headersBase,
        ...authHeaders,
      },
      body: JSON.stringify(payload),
    });
  };

  let upstreamResponse: Response;
  try {
    upstreamResponse = await sendUpstreamRequest(openAIRequest, targetURLs[0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network error';
    lastProxyError = message;
    writeJSON(res, 502, createAnthropicErrorBody(message));
    return;
  }

  if (!upstreamResponse.ok) {
    if (upstreamResponse.status === 404 && targetURLs.length > 1) {
      for (let i = 1; i < targetURLs.length; i += 1) {
        const retryURL = targetURLs[i];
        try {
          upstreamResponse = await sendUpstreamRequest(openAIRequest, retryURL);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Network error';
          lastProxyError = message;
          writeJSON(res, 502, createAnthropicErrorBody(message));
          return;
        }
        if (upstreamResponse.ok || upstreamResponse.status !== 404) {
          break;
        }
      }
    }

    if (!upstreamResponse.ok) {
      const firstErrorText = await upstreamResponse.text();
      let firstErrorMessage = extractErrorMessage(firstErrorText);
      if (firstErrorMessage === 'Upstream API request failed') {
        firstErrorMessage = `Upstream API request failed (${upstreamResponse.status}) ${currentTargetURL}`;
      }

    // Some OpenAI-compatible providers (e.g. DeepSeek) enforce strict max_tokens ranges.
    // Retry once with a clamped value when the upstream response includes the allowed range.
    if (upstreamResponse.status === 400) {
      const clampResult = clampMaxTokensFromError(openAIRequest, firstErrorMessage);
      if (clampResult.changed) {
        try {
          upstreamResponse = await sendUpstreamRequest(openAIRequest, currentTargetURL);
          if (!upstreamResponse.ok) {
            const retryErrorText = await upstreamResponse.text();
            firstErrorMessage = extractErrorMessage(retryErrorText);
          } else {
            console.info(
              `[cowork-openai-compat-proxy] Retried request with clamped max_tokens=${clampResult.clampedTo}`
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Network error';
          lastProxyError = message;
          writeJSON(res, 502, createAnthropicErrorBody(message));
          return;
        }
      }
    }

    if (!upstreamResponse.ok) {
      lastProxyError = firstErrorMessage;
      writeJSON(res, upstreamResponse.status, createAnthropicErrorBody(firstErrorMessage));
      return;
    }
    }
  }

  lastProxyError = null;

  if (stream) {
    await handleStreamResponse(upstreamResponse, res);
    return;
  }

  let upstreamJSON: unknown;
  try {
    upstreamJSON = await upstreamResponse.json();
  } catch {
    lastProxyError = 'Failed to parse upstream JSON response';
    writeJSON(res, 502, createAnthropicErrorBody('Failed to parse upstream JSON response'));
    return;
  }

  cacheToolCallExtraContentFromOpenAIResponse(upstreamJSON);

  const anthropicResponse = openAIToAnthropic(upstreamJSON);
  writeJSON(res, 200, anthropicResponse);
}

export async function startCoworkOpenAICompatProxy(): Promise<void> {
  if (proxyServer) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleRequest(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : 'Internal proxy error';
        lastProxyError = message;
        if (!res.headersSent) {
          writeJSON(res, 500, createAnthropicErrorBody(message));
        } else {
          res.end();
        }
      });
    });

    server.on('error', (error) => {
      lastProxyError = error.message;
      reject(error);
    });

    server.listen(0, LOCAL_HOST, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind OpenAI compatibility proxy port'));
        return;
      }

      proxyServer = server;
      proxyPort = addr.port;
      lastProxyError = null;
      resolve();
    });
  });
}

export async function stopCoworkOpenAICompatProxy(): Promise<void> {
  if (!proxyServer) {
    return;
  }

  const server = proxyServer;
  proxyServer = null;
  proxyPort = null;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function configureCoworkOpenAICompatProxy(config: OpenAICompatUpstreamConfig): void {
  upstreamConfig = {
    ...config,
    baseURL: config.baseURL.trim(),
    apiKey: config.apiKey?.trim(),
    upstreamKind: config.upstreamKind ?? 'openai',
  };
  lastProxyError = null;
}

export function getCoworkOpenAICompatProxyBaseURL(): string | null {
  if (!proxyServer || !proxyPort) {
    return null;
  }
  return `http://${LOCAL_HOST}:${proxyPort}`;
}

/**
 * Get the proxy base URL for internal API use (scheduled tasks, etc.).
 * Unlike getCoworkOpenAICompatProxyBaseURL which is for the LLM proxy,
 * this always returns the local proxy URL regardless of API format.
 */
export function getInternalApiBaseURL(): string | null {
  return getCoworkOpenAICompatProxyBaseURL();
}

export function getCoworkOpenAICompatProxyStatus(): OpenAICompatProxyStatus {
  return {
    running: Boolean(proxyServer),
    baseURL: getCoworkOpenAICompatProxyBaseURL(),
    hasUpstream: Boolean(upstreamConfig),
    upstreamBaseURL: upstreamConfig?.baseURL || null,
    upstreamModel: upstreamConfig?.model || null,
    upstreamKind: upstreamConfig?.upstreamKind || null,
    lastError: lastProxyError,
  };
}
