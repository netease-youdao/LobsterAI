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
import type { ScheduledTaskStore, ScheduledTaskInput } from '../scheduledTaskStore';
import type { Scheduler } from './scheduler';

export type OpenAICompatUpstreamConfig = {
  baseURL: string;
  apiKey?: string;
  model: string;
  provider?: string;
};

export type OpenAICompatProxyTarget = 'local' | 'sandbox';

export type OpenAICompatProxyStatus = {
  running: boolean;
  baseURL: string | null;
  hasUpstream: boolean;
  upstreamBaseURL: string | null;
  upstreamModel: string | null;
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

type UpstreamAPIType = 'chat_completions' | 'responses';

type ResponsesFunctionCallState = {
  outputIndex: number;
  callId: string;
  itemId: string;
  name: string;
  extraContent?: unknown;
  argumentsBuffer: string;
  finalArguments: string;
  emitted: boolean;
  metadataEmitted: boolean;
};

type ResponsesStreamContext = {
  functionCallByOutputIndex: Map<number, ResponsesFunctionCallState>;
  functionCallByCallId: Map<string, ResponsesFunctionCallState>;
  functionCallByItemId: Map<string, ResponsesFunctionCallState>;
  nextToolIndex: number;
  hasAnyDelta: boolean;
};

const PROXY_BIND_HOST = '0.0.0.0';
const LOCAL_HOST = '127.0.0.1';
const SANDBOX_HOST = '10.0.2.2';
const GEMINI_FALLBACK_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

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

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

function normalizeFunctionArguments(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
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

function hydrateOpenAIRequestToolCalls(
  body: Record<string, unknown>,
  provider?: string,
  baseURL?: string
): void {
  const isGemini =
    provider === 'gemini' || Boolean(baseURL?.includes('generativelanguage.googleapis.com'));
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
          continue;
        }
      }

      if (isGemini) {
        // Gemini requires thought signatures for tool calls; use a documented fallback when missing.
        toolCallObj.extra_content = {
          google: {
            thought_signature: GEMINI_FALLBACK_THOUGHT_SIGNATURE,
          },
        };
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

function resolveUpstreamAPIType(provider?: string): UpstreamAPIType {
  return provider?.toLowerCase() === 'openai' ? 'responses' : 'chat_completions';
}

function buildOpenAIResponsesURL(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/, '');
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

function buildUpstreamTargetUrls(baseURL: string, apiType: UpstreamAPIType): string[] {
  if (apiType === 'responses') {
    return [buildOpenAIResponsesURL(baseURL)];
  }

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

function extractTextFromChatContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  const chunks: string[] = [];
  for (const part of toArray(content)) {
    const partObj = toOptionalObject(part);
    if (!partObj) {
      continue;
    }
    const partText = toString(partObj.text);
    if (partText) {
      chunks.push(partText);
    }
  }
  return chunks.join('');
}

function convertUserChatContentToResponsesInput(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content
      ? [{ type: 'input_text', text: content }]
      : [];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const item of toArray(content)) {
    const itemObj = toOptionalObject(item);
    if (!itemObj) {
      continue;
    }

    const itemType = toString(itemObj.type);
    if (itemType === 'text') {
      const text = toString(itemObj.text);
      if (text) {
        parts.push({ type: 'input_text', text });
      }
      continue;
    }

    if (itemType === 'image_url') {
      const imageURLObj = toOptionalObject(itemObj.image_url);
      const imageURL = toString(imageURLObj?.url) || toString(itemObj.image_url);
      if (imageURL) {
        parts.push({ type: 'input_image', image_url: imageURL });
      }
    }
  }

  return parts;
}

function normalizeResponsesToolsFromChat(toolsInput: unknown): Array<Record<string, unknown>> {
  const normalizedTools: Array<Record<string, unknown>> = [];

  for (const tool of toArray(toolsInput)) {
    const toolObj = toOptionalObject(tool);
    if (!toolObj) {
      continue;
    }

    const toolType = toString(toolObj.type);
    if (toolType !== 'function') {
      normalizedTools.push(toolObj);
      continue;
    }

    const functionObj = toOptionalObject(toolObj.function);
    const name = toString(toolObj.name) || toString(functionObj?.name);
    if (!name) {
      continue;
    }

    const normalized: Record<string, unknown> = {
      type: 'function',
      name,
    };

    const description = toString(toolObj.description) || toString(functionObj?.description);
    if (description) {
      normalized.description = description;
    }

    const parameters = toolObj.parameters ?? functionObj?.parameters;
    if (parameters !== undefined) {
      normalized.parameters = parameters;
    }

    const strict = toolObj.strict ?? functionObj?.strict;
    if (typeof strict === 'boolean') {
      normalized.strict = strict;
    }

    normalizedTools.push(normalized);
  }

  return normalizedTools;
}

function normalizeResponsesToolChoiceFromChat(toolChoice: unknown): unknown {
  if (typeof toolChoice === 'string') {
    return toolChoice;
  }

  const toolChoiceObj = toOptionalObject(toolChoice);
  if (!toolChoiceObj) {
    return toolChoice;
  }

  const normalizedType = toString(toolChoiceObj.type).toLowerCase();
  if (normalizedType === 'any') {
    return 'required';
  }
  if (normalizedType === 'auto' || normalizedType === 'none' || normalizedType === 'required') {
    return normalizedType;
  }
  if (normalizedType === 'function' || normalizedType === 'tool') {
    const functionObj = toOptionalObject(toolChoiceObj.function);
    const name = toString(toolChoiceObj.name) || toString(functionObj?.name);
    if (name) {
      return {
        type: 'function',
        name,
      };
    }
  }

  return toolChoice;
}

function convertChatCompletionsRequestToResponsesRequest(
  chatRequest: Record<string, unknown>
): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  const input: Array<Record<string, unknown>> = [];
  const instructions: string[] = [];
  const unresolvedFunctionCalls = new Map<string, { name: string; hasOutput: boolean }>();

  if (chatRequest.model !== undefined) {
    request.model = chatRequest.model;
  }
  if (chatRequest.stream !== undefined) {
    request.stream = chatRequest.stream;
  }
  if (chatRequest.temperature !== undefined) {
    request.temperature = chatRequest.temperature;
  }
  if (chatRequest.top_p !== undefined) {
    request.top_p = chatRequest.top_p;
  }
  const normalizedTools = normalizeResponsesToolsFromChat(chatRequest.tools);
  if (normalizedTools.length > 0) {
    request.tools = normalizedTools;
  }
  if (chatRequest.tool_choice !== undefined) {
    request.tool_choice = normalizeResponsesToolChoiceFromChat(chatRequest.tool_choice);
  }

  const maxOutputTokens = toNumber(chatRequest.max_output_tokens)
    ?? toNumber(chatRequest.max_completion_tokens)
    ?? toNumber(chatRequest.max_tokens);
  if (maxOutputTokens !== null) {
    request.max_output_tokens = maxOutputTokens;
  }

  for (const message of toArray(chatRequest.messages)) {
    const messageObj = toOptionalObject(message);
    if (!messageObj) {
      continue;
    }

    const role = toString(messageObj.role);
    if (role === 'system') {
      const text = extractTextFromChatContent(messageObj.content);
      if (text) {
        instructions.push(text);
      }
      continue;
    }

    if (role === 'tool') {
      const toolCallId = toString(messageObj.tool_call_id);
      const output = stringifyUnknown(messageObj.content);
      if (toolCallId && output) {
        input.push({
          type: 'function_call_output',
          call_id: toolCallId,
          output,
        });
      }
      continue;
    }

    if (role === 'assistant') {
      const text = extractTextFromChatContent(messageObj.content);
      if (text) {
        input.push({
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }

      for (const toolCall of toArray(messageObj.tool_calls)) {
        const toolCallObj = toOptionalObject(toolCall);
        const functionObj = toOptionalObject(toolCallObj?.function);
        if (!toolCallObj || !functionObj) {
          continue;
        }
        const callId = toString(toolCallObj.call_id) || toString(toolCallObj.id);
        const name = toString(functionObj.name);
        const argumentsText = normalizeFunctionArguments(functionObj.arguments) || '{}';
        if (!callId || !name) {
          continue;
        }

        const functionCallItem: Record<string, unknown> = {
          type: 'function_call',
          call_id: callId,
          name,
          arguments: argumentsText,
        };
        const extraContent = normalizeToolCallExtraContent(toolCallObj);
        if (extraContent !== undefined) {
          functionCallItem.extra_content = extraContent;
        }
        input.push(functionCallItem);
        unresolvedFunctionCalls.set(callId, {
          name,
          hasOutput: false,
        });
      }
      continue;
    }

    const userParts = convertUserChatContentToResponsesInput(messageObj.content);
    if (userParts.length > 0) {
      input.push({
        role: role || 'user',
        content: userParts,
      });
    }
  }

  if (instructions.length > 0) {
    request.instructions = instructions.join('\n\n');
  }

  for (const messageItem of input) {
    if (toString(messageItem.type) !== 'function_call_output') {
      continue;
    }
    const callId = toString(messageItem.call_id);
    if (!callId) {
      continue;
    }
    const existing = unresolvedFunctionCalls.get(callId);
    if (existing) {
      existing.hasOutput = true;
      unresolvedFunctionCalls.set(callId, existing);
    }
  }

  for (const [callId, callInfo] of unresolvedFunctionCalls.entries()) {
    if (callInfo.hasOutput) {
      continue;
    }
    // OpenAI Responses requires each historical function_call to have a matching output.
    // When upstream tool execution fails before producing a tool_result, auto-close it here.
    input.push({
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({
        error: `Missing tool output for function call "${callId}" (${callInfo.name || 'unknown'}). Auto-closed by compatibility proxy.`,
      }),
    });
  }

  request.input = input;

  return request;
}

function normalizeToolName(value: unknown): string {
  return toString(value).trim().toLowerCase();
}

function filterOpenAIToolsForProvider(
  openAIRequest: Record<string, unknown>,
  provider?: string
): void {
  if (provider !== 'openai') {
    return;
  }

  const tools = toArray(openAIRequest.tools);
  if (tools.length === 0) {
    return;
  }

  const filteredTools = tools.filter((tool) => {
    const toolObj = toOptionalObject(tool);
    if (!toolObj) return true;
    const functionObj = toOptionalObject(toolObj.function);
    const toolName = normalizeToolName(toolObj.name) || normalizeToolName(functionObj?.name);
    if (!toolName) return true;
    // OpenAI path should use skills by reading SKILL.md via normal tools, not Skill tool.
    return toolName !== 'skill';
  });

  if (filteredTools.length !== tools.length) {
    openAIRequest.tools = filteredTools;
    const toolChoiceObj = toOptionalObject(openAIRequest.tool_choice);
    if (toolChoiceObj) {
      const forcedName = normalizeToolName(toolChoiceObj.name)
        || normalizeToolName(toOptionalObject(toolChoiceObj.function)?.name);
      if (forcedName === 'skill') {
        openAIRequest.tool_choice = 'auto';
      }
    }
  }
}

/**
 * MiniMax API only accepts 'system', 'user', and 'assistant' roles.
 * OpenAI's newer API uses 'developer' role which MiniMax doesn't recognize.
 * This function remaps 'developer' to 'system' for MiniMax compatibility.
 */
function remapMessageRolesForMiniMax(
  openAIRequest: Record<string, unknown>,
  provider?: string
): void {
  if (provider !== 'minimax') {
    return;
  }

  const messages = toArray(openAIRequest.messages);
  if (messages.length === 0) {
    return;
  }

  for (const message of messages) {
    const messageObj = toOptionalObject(message);
    if (!messageObj) {
      continue;
    }

    const role = toString(messageObj.role);
    if (role === 'developer') {
      messageObj.role = 'system';
    }
  }
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

function shouldUseMaxCompletionTokensForModel(model: unknown): boolean {
  if (typeof model !== 'string') {
    return false;
  }
  const normalizedModel = model.toLowerCase();
  const resolvedModel = normalizedModel.includes('/')
    ? normalizedModel.slice(normalizedModel.lastIndexOf('/') + 1)
    : normalizedModel;
  return resolvedModel.startsWith('gpt-5')
    || resolvedModel.startsWith('o1')
    || resolvedModel.startsWith('o3')
    || resolvedModel.startsWith('o4');
}

function normalizeMaxTokensFieldForOpenAIProvider(
  openAIRequest: Record<string, unknown>,
  provider?: string
): void {
  if (provider !== 'openai') {
    return;
  }
  if (!shouldUseMaxCompletionTokensForModel(openAIRequest.model)) {
    return;
  }
  const maxTokens = openAIRequest.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) {
    return;
  }
  openAIRequest.max_completion_tokens = maxTokens;
  delete openAIRequest.max_tokens;
}

/**
 * Merge multiple system messages into a single one at the beginning.
 * Some OpenAI-compatible providers (e.g. MiniMax) reject requests containing
 * more than one system message, returning error 2013 "invalid chat setting".
 * This is safe for all providers since the semantic meaning is preserved.
 */
function mergeSystemMessagesForProvider(
  openAIRequest: Record<string, unknown>
): void {
  const messages = toArray(openAIRequest.messages);
  if (messages.length === 0) {
    return;
  }

  const systemTexts: string[] = [];
  const nonSystemMessages: unknown[] = [];
  for (const msg of messages) {
    const msgObj = toOptionalObject(msg);
    if (!msgObj) {
      nonSystemMessages.push(msg);
      continue;
    }
    if (toString(msgObj.role) === 'system') {
      const text = typeof msgObj.content === 'string' ? msgObj.content : '';
      if (text) {
        systemTexts.push(text);
      }
    } else {
      nonSystemMessages.push(msg);
    }
  }

  // Only rewrite if there are 2+ system messages; otherwise leave as-is
  if (systemTexts.length <= 1) {
    return;
  }

  const merged: unknown[] = [];
  merged.push({ role: 'system', content: systemTexts.join('\n') });
  merged.push(...nonSystemMessages);
  openAIRequest.messages = merged;
}

function isMaxTokensUnsupportedError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return normalized.includes('max_tokens')
    && normalized.includes('max_completion_tokens')
    && normalized.includes('not supported');
}

/**
 * Detect errors where the upstream model does not support tool calling.
 * Ollama returns messages like "registry.ollama.ai/library/gemma3:1b does not support tools".
 */
function isToolsUnsupportedError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return normalized.includes('does not support tools')
    || normalized.includes('tool use is not supported');
}

/**
 * Strip tools and tool_choice from an OpenAI-format request.
 * Returns true if tools were actually removed.
 */
function stripToolsFromRequest(openAIRequest: Record<string, unknown>): boolean {
  const tools = openAIRequest.tools;
  if (!tools || (Array.isArray(tools) && tools.length === 0)) {
    return false;
  }
  delete openAIRequest.tools;
  delete openAIRequest.tool_choice;
  return true;
}

function convertMaxTokensToMaxCompletionTokens(
  openAIRequest: Record<string, unknown>
): { changed: boolean; convertedTo?: number } {
  const maxTokens = openAIRequest.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) {
    return { changed: false };
  }
  openAIRequest.max_completion_tokens = maxTokens;
  delete openAIRequest.max_tokens;
  return { changed: true, convertedTo: maxTokens };
}

function writeJSON(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
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

function createResponsesStreamContext(): ResponsesStreamContext {
  return {
    functionCallByOutputIndex: new Map<number, ResponsesFunctionCallState>(),
    functionCallByCallId: new Map<string, ResponsesFunctionCallState>(),
    functionCallByItemId: new Map<string, ResponsesFunctionCallState>(),
    nextToolIndex: 0,
    hasAnyDelta: false,
  };
}

function resolveResponsesObject(body: unknown): Record<string, unknown> {
  const source = toOptionalObject(body);
  if (!source) {
    return {};
  }
  const nested = toOptionalObject(source.response);
  if (nested) {
    return nested;
  }
  return source;
}

function extractResponsesReasoningText(itemObj: Record<string, unknown>): string {
  const summaryTexts: string[] = [];
  for (const summaryItem of toArray(itemObj.summary)) {
    const summaryObj = toOptionalObject(summaryItem);
    if (!summaryObj) {
      continue;
    }
    const summaryText = toString(summaryObj.text);
    if (summaryText) {
      summaryTexts.push(summaryText);
    }
  }
  if (summaryTexts.length > 0) {
    return summaryTexts.join('');
  }

  const directText = toString(itemObj.text);
  if (directText) {
    return directText;
  }
  return '';
}

function detectResponsesFinishReason(responseObj: Record<string, unknown>): string {
  const output = toArray(responseObj.output);
  const hasFunctionCall = output.some((item) => toString(toOptionalObject(item)?.type) === 'function_call');
  if (hasFunctionCall) {
    return 'tool_calls';
  }

  const status = toString(responseObj.status);
  const incompleteReason = toString(toOptionalObject(responseObj.incomplete_details)?.reason);
  if (
    status === 'incomplete'
    && (incompleteReason === 'max_output_tokens' || incompleteReason === 'max_tokens')
  ) {
    return 'length';
  }
  return 'stop';
}

function convertResponsesToOpenAIResponse(body: unknown): Record<string, unknown> {
  const responseObj = resolveResponsesObject(body);
  const output = toArray(responseObj.output);

  const textParts: Array<{ type: 'text'; text: string }> = [];
  const reasoningParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const item of output) {
    const itemObj = toOptionalObject(item);
    if (!itemObj) {
      continue;
    }

    const itemType = toString(itemObj.type);
    if (itemType === 'message') {
      for (const contentItem of toArray(itemObj.content)) {
        const contentObj = toOptionalObject(contentItem);
        if (!contentObj) {
          continue;
        }
        const contentType = toString(contentObj.type);
        if (contentType === 'output_text' || contentType === 'text' || contentType === 'input_text') {
          const text = toString(contentObj.text);
          if (text) {
            textParts.push({ type: 'text', text });
          }
        }
      }
      continue;
    }

    if (itemType === 'reasoning') {
      const reasoningText = extractResponsesReasoningText(itemObj);
      if (reasoningText) {
        reasoningParts.push(reasoningText);
      }
      continue;
    }

    if (itemType === 'function_call') {
      const callId = toString(itemObj.call_id) || toString(itemObj.id);
      const name = toString(itemObj.name);
      if (!callId || !name) {
        continue;
      }
      const toolCall: Record<string, unknown> = {
        id: callId,
        type: 'function',
        function: {
          name,
          arguments: normalizeFunctionArguments(itemObj.arguments) || '{}',
        },
      };
      const extraContent = normalizeToolCallExtraContent(itemObj);
      if (extraContent !== undefined) {
        toolCall.extra_content = extraContent;
      }
      toolCalls.push(toolCall);
    }
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
  };
  if (textParts.length === 1 && textParts[0].type === 'text') {
    message.content = textParts[0].text;
  } else if (textParts.length > 1) {
    message.content = textParts;
  } else {
    message.content = null;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  if (reasoningParts.length > 0) {
    message.reasoning_content = reasoningParts.join('');
  }

  const usage = toOptionalObject(responseObj.usage);
  return {
    id: toString(responseObj.id),
    model: toString(responseObj.model),
    choices: [
      {
        message,
        finish_reason: detectResponsesFinishReason(responseObj),
      },
    ],
    usage: {
      prompt_tokens: toNumber(usage?.input_tokens) ?? toNumber(usage?.prompt_tokens) ?? 0,
      completion_tokens: toNumber(usage?.output_tokens) ?? toNumber(usage?.completion_tokens) ?? 0,
    },
  };
}

function cacheToolCallExtraContentFromResponsesResponse(body: unknown): void {
  const responseObj = resolveResponsesObject(body);
  for (const item of toArray(responseObj.output)) {
    const itemObj = toOptionalObject(item);
    if (!itemObj || toString(itemObj.type) !== 'function_call') {
      continue;
    }
    const toolCallId = toString(itemObj.call_id) || toString(itemObj.id);
    const extraContent = normalizeToolCallExtraContent(itemObj);
    cacheToolCallExtraContent(toolCallId, extraContent);
  }
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

function parseSSEPacket(packet: string): { event: string; payload: string } {
  const lines = packet.split(/\r?\n/);
  const dataLines: string[] = [];
  let event = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return {
    event,
    payload: dataLines.join('\n'),
  };
}

function findSSEPacketBoundary(
  buffer: string
): { index: number; separatorLength: number } | null {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match || typeof match.index !== 'number') {
    return null;
  }

  return {
    index: match.index,
    separatorLength: match[0].length,
  };
}

function extractResponsesFunctionCallMetadata(
  payloadObj: Record<string, unknown>,
  itemObj: Record<string, unknown> | null
): {
  outputIndex: number | null;
  callId: string;
  itemId: string;
  name: string;
  extraContent: unknown;
} {
  const outputIndex = toNumber(payloadObj.output_index) ?? toNumber(itemObj?.output_index);
  const callId = toString(payloadObj.call_id) || toString(itemObj?.call_id);
  const itemId = toString(payloadObj.item_id) || toString(itemObj?.id);
  const name = toString(payloadObj.name) || toString(itemObj?.name);
  const extraContent = itemObj ? normalizeToolCallExtraContent(itemObj) : undefined;
  return {
    outputIndex,
    callId,
    itemId,
    name,
    extraContent,
  };
}

function registerResponsesFunctionCallState(
  context: ResponsesStreamContext,
  payloadObj: Record<string, unknown>,
  itemObj: Record<string, unknown> | null
): ResponsesFunctionCallState {
  const metadata = extractResponsesFunctionCallMetadata(payloadObj, itemObj);

  let callState = metadata.callId
    ? context.functionCallByCallId.get(metadata.callId)
    : undefined;
  if (!callState && metadata.itemId) {
    callState = context.functionCallByItemId.get(metadata.itemId);
  }
  if (!callState && metadata.outputIndex !== null) {
    callState = context.functionCallByOutputIndex.get(metadata.outputIndex);
  }

  if (!callState) {
    const outputIndex = metadata.outputIndex !== null
      ? metadata.outputIndex
      : context.nextToolIndex;
    callState = {
      outputIndex,
      callId: '',
      itemId: '',
      name: '',
      extraContent: undefined,
      argumentsBuffer: '',
      finalArguments: '',
      emitted: false,
      metadataEmitted: false,
    };
    context.functionCallByOutputIndex.set(outputIndex, callState);
    context.nextToolIndex = Math.max(context.nextToolIndex, outputIndex + 1);
  } else if (metadata.outputIndex !== null && callState.outputIndex !== metadata.outputIndex) {
    context.functionCallByOutputIndex.delete(callState.outputIndex);
    callState.outputIndex = metadata.outputIndex;
    context.functionCallByOutputIndex.set(callState.outputIndex, callState);
    context.nextToolIndex = Math.max(context.nextToolIndex, callState.outputIndex + 1);
  } else {
    context.nextToolIndex = Math.max(context.nextToolIndex, callState.outputIndex + 1);
  }

  if (metadata.callId) {
    callState.callId = metadata.callId;
    context.functionCallByCallId.set(metadata.callId, callState);
  }
  if (metadata.itemId) {
    callState.itemId = metadata.itemId;
    context.functionCallByItemId.set(metadata.itemId, callState);
  }
  if (metadata.name) {
    callState.name = metadata.name;
  }
  if (metadata.extraContent !== undefined) {
    callState.extraContent = metadata.extraContent;
  }

  context.functionCallByOutputIndex.set(callState.outputIndex, callState);
  return callState;
}

function syncToolCallStateWithResponsesFunctionCall(
  state: StreamState,
  callState: ResponsesFunctionCallState
): ToolCallState {
  const toolCall = state.toolCalls[callState.outputIndex] ?? {};
  if (callState.callId) {
    toolCall.id = callState.callId;
  } else if (callState.itemId) {
    toolCall.id = callState.itemId;
  } else if (!toolCall.id) {
    toolCall.id = `tool_call_${callState.outputIndex}`;
  }
  if (callState.name) {
    toolCall.name = callState.name;
  }
  if (callState.extraContent !== undefined) {
    toolCall.extraContent = callState.extraContent;
  }
  state.toolCalls[callState.outputIndex] = toolCall;
  if (toolCall.id && toolCall.extraContent !== undefined) {
    cacheToolCallExtraContent(toolCall.id, toolCall.extraContent);
  }
  return toolCall;
}

function emitResponsesFunctionCallChunk(
  res: http.ServerResponse,
  state: StreamState,
  callState: ResponsesFunctionCallState,
  options: {
    includeName: boolean;
    argumentsText?: string;
    responseId?: string;
    model?: string;
  }
): void {
  const toolCall = syncToolCallStateWithResponsesFunctionCall(state, callState);

  const functionObj: Record<string, unknown> = {};
  if (options.includeName && toolCall.name) {
    functionObj.name = toolCall.name;
  }

  const argumentsText = options.argumentsText ?? '';
  if (argumentsText) {
    functionObj.arguments = argumentsText;
  }

  if (Object.keys(functionObj).length === 0) {
    return;
  }

  processOpenAIChunk(res, state, {
    id: options.responseId || undefined,
    model: options.model || undefined,
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: callState.outputIndex,
              id: toolCall.id,
              type: 'function',
              function: functionObj,
            },
          ],
        },
      },
    ],
  });
}

function emitResponsesFunctionCallMetadataOnce(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  callState: ResponsesFunctionCallState,
  responseId?: string,
  model?: string
): void {
  if (callState.metadataEmitted) {
    return;
  }
  if (!callState.name) {
    return;
  }

  emitResponsesFunctionCallChunk(res, state, callState, {
    includeName: true,
    responseId,
    model,
  });
  callState.metadataEmitted = true;
  context.hasAnyDelta = true;
}

function emitResponsesFunctionCallArgumentsOnce(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  callState: ResponsesFunctionCallState,
  argumentsText: string,
  responseId?: string,
  model?: string
): void {
  if (callState.emitted) {
    return;
  }

  const resolvedArguments = argumentsText
    || callState.finalArguments
    || callState.argumentsBuffer
    || '{}';
  if (!resolvedArguments) {
    return;
  }

  callState.finalArguments = resolvedArguments;
  emitResponsesFunctionCallChunk(res, state, callState, {
    includeName: true,
    argumentsText: resolvedArguments,
    responseId,
    model,
  });
  callState.emitted = true;
  callState.metadataEmitted = true;
  context.hasAnyDelta = true;
}

function emitResponsesCompletedFunctionCalls(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  responseObj: Record<string, unknown>
): void {
  const responseId = toString(responseObj.id);
  const model = toString(responseObj.model);

  for (const [index, item] of toArray(responseObj.output).entries()) {
    const itemObj = toOptionalObject(item);
    if (!itemObj || toString(itemObj.type) !== 'function_call') {
      continue;
    }

    const payloadObj: Record<string, unknown> = {
      response_id: responseId,
      model,
      call_id: toString(itemObj.call_id),
      item_id: toString(itemObj.id),
      name: toString(itemObj.name),
    };
    const itemOutputIndex = toNumber(itemObj.output_index);
    if (itemOutputIndex !== null) {
      payloadObj.output_index = itemOutputIndex;
    } else {
      payloadObj.output_index = index;
    }

    const callState = registerResponsesFunctionCallState(context, payloadObj, itemObj);
    emitResponsesFunctionCallMetadataOnce(
      res,
      state,
      context,
      callState,
      responseId,
      model
    );

    const finalizedArguments = normalizeFunctionArguments(itemObj.arguments)
      || callState.finalArguments
      || callState.argumentsBuffer
      || '{}';
    emitResponsesFunctionCallArgumentsOnce(
      res,
      state,
      context,
      callState,
      finalizedArguments,
      responseId,
      model
    );
  }
}

function emitResponsesFallbackContent(
  res: http.ServerResponse,
  state: StreamState,
  responseObj: Record<string, unknown>,
  context: ResponsesStreamContext
): void {
  const syntheticOpenAIResponse = convertResponsesToOpenAIResponse(responseObj);
  const firstChoice = toOptionalObject(toArray(syntheticOpenAIResponse.choices)[0]);
  const message = toOptionalObject(firstChoice?.message);
  if (!message) {
    return;
  }

  const reasoning = toString(message.reasoning_content) || toString(message.reasoning);
  if (reasoning) {
    processOpenAIChunk(res, state, {
      id: toString(syntheticOpenAIResponse.id),
      model: toString(syntheticOpenAIResponse.model),
      choices: [{ delta: { reasoning } }],
    });
  }

  const messageContent = message.content;
  if (typeof messageContent === 'string' && messageContent) {
    processOpenAIChunk(res, state, {
      id: toString(syntheticOpenAIResponse.id),
      model: toString(syntheticOpenAIResponse.model),
      choices: [{ delta: { content: messageContent } }],
    });
  } else if (Array.isArray(messageContent)) {
    for (const part of messageContent) {
      const partObj = toOptionalObject(part);
      const text = toString(partObj?.text);
      if (text) {
        processOpenAIChunk(res, state, {
          id: toString(syntheticOpenAIResponse.id),
          model: toString(syntheticOpenAIResponse.model),
          choices: [{ delta: { content: text } }],
        });
      }
    }
  }

  for (const toolCall of toArray(message.tool_calls)) {
    const toolCallObj = toOptionalObject(toolCall);
    const functionObj = toOptionalObject(toolCallObj?.function);
    if (!toolCallObj || !functionObj) {
      continue;
    }

    const payloadObj: Record<string, unknown> = {
      response_id: toString(syntheticOpenAIResponse.id),
      model: toString(syntheticOpenAIResponse.model),
      call_id: toString(toolCallObj.id),
      name: toString(functionObj.name),
    };
    const callState = registerResponsesFunctionCallState(context, payloadObj, null);
    emitResponsesFunctionCallMetadataOnce(
      res,
      state,
      context,
      callState,
      toString(syntheticOpenAIResponse.id),
      toString(syntheticOpenAIResponse.model)
    );
    emitResponsesFunctionCallArgumentsOnce(
      res,
      state,
      context,
      callState,
      toString(functionObj.arguments) || '{}',
      toString(syntheticOpenAIResponse.id),
      toString(syntheticOpenAIResponse.model)
    );
  }
}

function processResponsesStreamEvent(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  event: string,
  payloadObj: Record<string, unknown>
): void {
  const eventType = event || toString(payloadObj.type);

  const responseObjFromPayload = toOptionalObject(payloadObj.response);
  if (responseObjFromPayload) {
    processOpenAIChunk(res, state, {
      id: toString(responseObjFromPayload.id),
      model: toString(responseObjFromPayload.model),
      choices: [],
    });
  }

  if (eventType === 'response.created') {
    return;
  }

  if (eventType === 'response.output_text.delta' || eventType === 'response.output.delta') {
    const textDelta = toString(payloadObj.delta);
    if (textDelta) {
      processOpenAIChunk(res, state, {
        id: toString(payloadObj.response_id),
        model: toString(payloadObj.model),
        choices: [{ delta: { content: textDelta } }],
      });
      context.hasAnyDelta = true;
    }
    return;
  }

  if (
    eventType === 'response.reasoning_summary_text.delta'
    || eventType === 'response.reasoning.delta'
  ) {
    const thinkingDelta = toString(payloadObj.delta);
    if (thinkingDelta) {
      processOpenAIChunk(res, state, {
        id: toString(payloadObj.response_id),
        model: toString(payloadObj.model),
        choices: [{ delta: { reasoning: thinkingDelta } }],
      });
      context.hasAnyDelta = true;
    }
    return;
  }

  if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
    const itemObj = toOptionalObject(payloadObj.item);
    if (!itemObj) {
      return;
    }

    if (toString(itemObj.type) === 'function_call') {
      const callState = registerResponsesFunctionCallState(context, payloadObj, itemObj);
      const responseId = toString(payloadObj.response_id);
      const model = toString(payloadObj.model);
      emitResponsesFunctionCallMetadataOnce(
        res,
        state,
        context,
        callState,
        responseId,
        model
      );

      if (eventType === 'response.output_item.done' && !callState.emitted) {
        const inlineArguments = normalizeFunctionArguments(itemObj.arguments);
        if (inlineArguments) {
          emitResponsesFunctionCallArgumentsOnce(
            res,
            state,
            context,
            callState,
            inlineArguments,
            responseId,
            model
          );
        }
      }
    }
    return;
  }

  if (eventType === 'response.function_call_arguments.delta') {
    const callState = registerResponsesFunctionCallState(context, payloadObj, null);
    const argumentsDelta = normalizeFunctionArguments(payloadObj.delta);
    if (!argumentsDelta) {
      return;
    }
    callState.argumentsBuffer += argumentsDelta;
    return;
  }

  if (eventType === 'response.function_call_arguments.done') {
    const callState = registerResponsesFunctionCallState(context, payloadObj, null);
    const argumentsDone = normalizeFunctionArguments(payloadObj.arguments)
      || callState.argumentsBuffer
      || '{}';
    callState.finalArguments = argumentsDone;
    emitResponsesFunctionCallArgumentsOnce(
      res,
      state,
      context,
      callState,
      argumentsDone,
      toString(payloadObj.response_id),
      toString(payloadObj.model)
    );
    return;
  }

  if (eventType === 'response.completed') {
    const responseObj = resolveResponsesObject(payloadObj);
    if (!context.hasAnyDelta) {
      emitResponsesFallbackContent(res, state, responseObj, context);
    }
    emitResponsesCompletedFunctionCalls(res, state, context, responseObj);

    const usage = toOptionalObject(responseObj.usage);
    processOpenAIChunk(res, state, {
      id: toString(responseObj.id),
      model: toString(responseObj.model),
      choices: [{ finish_reason: detectResponsesFinishReason(responseObj) }],
      usage: {
        prompt_tokens: toNumber(usage?.input_tokens) ?? toNumber(usage?.prompt_tokens) ?? 0,
        completion_tokens: toNumber(usage?.output_tokens) ?? toNumber(usage?.completion_tokens) ?? 0,
      },
    });
  }
}

async function handleResponsesStreamResponse(
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
  const context = createResponsesStreamContext();

  let buffer = '';
  let sawDoneMarker = false;

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

    let boundary = findSSEPacketBoundary(buffer);
    while (boundary) {
      const packet = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.separatorLength);

      const parsedPacket = parseSSEPacket(packet);
      const payload = parsedPacket.payload;
      if (!payload) {
        boundary = findSSEPacketBoundary(buffer);
        continue;
      }

      if (payload === '[DONE]') {
        flushDone();
        sawDoneMarker = true;
        break;
      }

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        processResponsesStreamEvent(res, state, context, parsedPacket.event, parsed);
      } catch {
        // Ignore malformed stream chunks.
      }

      boundary = findSSEPacketBoundary(buffer);
    }

    if (sawDoneMarker) {
      break;
    }
  }

  if (sawDoneMarker) {
    try {
      await reader.cancel();
    } catch {
      // noop
    }
  }

  flushDone();
  res.end();
}

async function handleChatCompletionsStreamResponse(
  upstreamResponse: Response,
  res: http.ServerResponse
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (!upstreamResponse.body) {
    console.warn('[CoworkProxy] Stream: upstream returned empty body');
    emitSSE(res, 'error', createAnthropicErrorBody('Upstream returned empty stream', 'stream_error'));
    res.end();
    return;
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const state = createStreamState();

  let buffer = '';
  let sawDoneMarker = false;
  let chunkCount = 0;

  const flushDone = () => {
    if (!state.hasMessageStart) {
      console.warn('[CoworkProxy] Stream: flushDone called but no message_start was emitted');
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

  console.log('[CoworkProxy] Stream: starting to read upstream SSE chunks');

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      console.log(`[CoworkProxy] Stream: upstream done after ${chunkCount} chunks, sawDoneMarker=${sawDoneMarker}`);
      break;
    }

    chunkCount++;
    buffer += decoder.decode(value, { stream: true });

    let boundary = findSSEPacketBoundary(buffer);
    while (boundary) {
      const packet = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.separatorLength);

      const lines = packet.split(/\r?\n/);
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      const payload = dataLines.join('\n');
      if (!payload) {
        boundary = findSSEPacketBoundary(buffer);
        continue;
      }

      if (payload === '[DONE]') {
        flushDone();
        sawDoneMarker = true;
        break;
      }

      try {
        const parsed = JSON.parse(payload) as OpenAIStreamChunk;
        processOpenAIChunk(res, state, parsed);
      } catch {
        // Ignore malformed stream chunks.
      }

      boundary = findSSEPacketBoundary(buffer);
    }

    if (sawDoneMarker) {
      break;
    }
  }

  if (sawDoneMarker) {
    try {
      await reader.cancel();
    } catch {
      // noop
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

  if (method === 'GET' && url.pathname === '/healthz') {
    writeJSON(res, 200, {
      ok: true,
      running: Boolean(proxyServer),
      hasUpstream: Boolean(upstreamConfig),
      lastError: lastProxyError,
    });
    return;
  }

  // Scheduled task creation API
  if (method === 'POST' && url.pathname === '/api/scheduled-tasks') {
    await handleCreateScheduledTask(req, res);
    return;
  }

  console.log(`[CoworkProxy] ${method} ${url.pathname}`);

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

  const upstreamAPIType = resolveUpstreamAPIType(upstreamConfig.provider);
  const openAIRequest = anthropicToOpenAI(parsedRequestBody);
  if (!openAIRequest.model) {
    openAIRequest.model = upstreamConfig.model;
  }

  // Force-remap model name to the user-configured upstream model.
  // The Claude Agent SDK may emit internal model names (e.g. claude-haiku-4-5-20251001)
  // for probe/warmup requests, which non-Anthropic providers don't recognize.
  if (upstreamConfig.provider && upstreamConfig.provider !== 'anthropic' && upstreamConfig.provider !== 'openai') {
    const requestModel = typeof openAIRequest.model === 'string' ? openAIRequest.model : '';
    if (requestModel !== upstreamConfig.model) {
      console.info(
        `[CoworkProxy] Remapping model: ${requestModel} -> ${upstreamConfig.model} (provider: ${upstreamConfig.provider})`
      );
      openAIRequest.model = upstreamConfig.model;
    }
  }
  filterOpenAIToolsForProvider(openAIRequest, upstreamConfig.provider);
  remapMessageRolesForMiniMax(openAIRequest, upstreamConfig.provider);
  hydrateOpenAIRequestToolCalls(openAIRequest, upstreamConfig.provider, upstreamConfig.baseURL);

  if (upstreamAPIType === 'chat_completions') {
    normalizeMaxTokensFieldForOpenAIProvider(openAIRequest, upstreamConfig.provider);
  }

  // Some providers (e.g. MiniMax) reject requests with multiple system messages.
  // Merge all system messages into one before sending to these providers.
  if (upstreamAPIType === 'chat_completions') {
    mergeSystemMessagesForProvider(openAIRequest);
  }

  const upstreamRequest = upstreamAPIType === 'responses'
    ? convertChatCompletionsRequestToResponsesRequest(openAIRequest)
    : openAIRequest;
  const stream = Boolean(upstreamRequest.stream);

  console.log(`[CoworkProxy] Upstream: apiType=${upstreamAPIType}, model=${upstreamRequest.model}, stream=${stream}, provider=${upstreamConfig.provider}`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (upstreamConfig.apiKey) {
    headers.Authorization = `Bearer ${upstreamConfig.apiKey}`;
  }

  const targetURLs = buildUpstreamTargetUrls(upstreamConfig.baseURL, upstreamAPIType);
  let currentTargetURL = targetURLs[0];

  const sendUpstreamRequest = async (
    payload: Record<string, unknown>,
    targetURL: string
  ): Promise<Response> => {
    currentTargetURL = targetURL;
    console.log(`[CoworkProxy] Sending upstream request to: ${targetURL}`);
    return session.defaultSession.fetch(targetURL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  };

  let upstreamResponse: Response;
  const fetchStartTime = Date.now();
  try {
    console.log(`[CoworkProxy] Awaiting upstream fetch (stream=${stream}, model=${upstreamRequest.model})...`);
    upstreamResponse = await sendUpstreamRequest(upstreamRequest, targetURLs[0]);
    const fetchDuration = Date.now() - fetchStartTime;
    console.log(`[CoworkProxy] Upstream response: status=${upstreamResponse.status}, ok=${upstreamResponse.ok}, fetchTime=${fetchDuration}ms, stream=${stream}`);
  } catch (error) {
    const fetchDuration = Date.now() - fetchStartTime;
    const message = error instanceof Error ? error.message : 'Network error';
    console.error(`[CoworkProxy] Upstream fetch error after ${fetchDuration}ms (stream=${stream}): ${message}`);
    lastProxyError = message;
    writeJSON(res, 502, createAnthropicErrorBody(message));
    return;
  }

  if (!upstreamResponse.ok) {
    if (upstreamResponse.status === 404 && targetURLs.length > 1) {
      for (let i = 1; i < targetURLs.length; i += 1) {
        const retryURL = targetURLs[i];
        try {
          upstreamResponse = await sendUpstreamRequest(upstreamRequest, retryURL);
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
      console.error(`[CoworkProxy] Upstream error: status=${upstreamResponse.status}, body=${firstErrorText.slice(0, 500)}`);
      let firstErrorMessage = extractErrorMessage(firstErrorText);
      if (firstErrorMessage === 'Upstream API request failed') {
        firstErrorMessage = `Upstream API request failed (${upstreamResponse.status}) ${currentTargetURL}`;
      }

      if (upstreamAPIType === 'chat_completions' && upstreamResponse.status === 400) {
        // Some Ollama models do not support tool calling.
        // When the upstream returns "does not support tools", strip tools and retry.
        if (isToolsUnsupportedError(firstErrorMessage)) {
          const stripped = stripToolsFromRequest(upstreamRequest);
          if (stripped) {
            try {
              upstreamResponse = await sendUpstreamRequest(upstreamRequest, currentTargetURL);
              if (!upstreamResponse.ok) {
                const retryErrorText = await upstreamResponse.text();
                firstErrorMessage = extractErrorMessage(retryErrorText);
              } else {
                console.info(
                  '[CoworkProxy] Retried request after stripping unsupported tools'
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

        if (isMaxTokensUnsupportedError(firstErrorMessage)) {
          const convertResult = convertMaxTokensToMaxCompletionTokens(upstreamRequest);
          if (convertResult.changed) {
            try {
              upstreamResponse = await sendUpstreamRequest(upstreamRequest, currentTargetURL);
              if (!upstreamResponse.ok) {
                const retryErrorText = await upstreamResponse.text();
                firstErrorMessage = extractErrorMessage(retryErrorText);
              } else {
                console.info(
                  '[cowork-openai-compat-proxy] Retried request with max_completion_tokens '
                    + `converted from max_tokens=${convertResult.convertedTo}`
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

        // Some OpenAI-compatible providers (e.g. DeepSeek) enforce strict max_tokens ranges.
        // Retry once with a clamped value when the upstream response includes the allowed range.
        if (!upstreamResponse.ok) {
          const clampResult = clampMaxTokensFromError(upstreamRequest, firstErrorMessage);
          if (clampResult.changed) {
            try {
              upstreamResponse = await sendUpstreamRequest(upstreamRequest, currentTargetURL);
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
    console.log(`[CoworkProxy] Handling streaming response (type=${upstreamAPIType})`);
    if (upstreamAPIType === 'responses') {
      await handleResponsesStreamResponse(upstreamResponse, res);
    } else {
      await handleChatCompletionsStreamResponse(upstreamResponse, res);
    }
    console.log('[CoworkProxy] Streaming response completed');
    return;
  }

  console.log('[CoworkProxy] Handling non-streaming response');
  let upstreamJSON: unknown;
  try {
    upstreamJSON = await upstreamResponse.json();
  } catch {
    lastProxyError = 'Failed to parse upstream JSON response';
    writeJSON(res, 502, createAnthropicErrorBody('Failed to parse upstream JSON response'));
    return;
  }

  if (upstreamAPIType === 'responses') {
    const syntheticOpenAIResponse = convertResponsesToOpenAIResponse(upstreamJSON);
    cacheToolCallExtraContentFromOpenAIResponse(syntheticOpenAIResponse);
    cacheToolCallExtraContentFromResponsesResponse(upstreamJSON);
    const anthropicResponse = openAIToAnthropic(syntheticOpenAIResponse);
    writeJSON(res, 200, anthropicResponse);
    return;
  }

  cacheToolCallExtraContentFromOpenAIResponse(upstreamJSON);

  const anthropicResponse = openAIToAnthropic(upstreamJSON);
  writeJSON(res, 200, anthropicResponse);
}

export const __openAICompatProxyTestUtils = {
  createStreamState,
  createResponsesStreamContext,
  findSSEPacketBoundary,
  processResponsesStreamEvent,
  convertChatCompletionsRequestToResponsesRequest,
  filterOpenAIToolsForProvider,
};

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

    server.listen(0, PROXY_BIND_HOST, () => {
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
  };
  lastProxyError = null;
}

export function getCoworkOpenAICompatProxyBaseURL(target: OpenAICompatProxyTarget = 'local'): string | null {
  if (!proxyServer || !proxyPort) {
    return null;
  }
  const host = target === 'sandbox' ? SANDBOX_HOST : LOCAL_HOST;
  return `http://${host}:${proxyPort}`;
}

/**
 * Get the proxy base URL for internal API use (scheduled tasks, etc.).
 * Unlike getCoworkOpenAICompatProxyBaseURL which is for the LLM proxy,
 * this always returns the local proxy URL regardless of API format.
 */
export function getInternalApiBaseURL(): string | null {
  return getCoworkOpenAICompatProxyBaseURL('local');
}

export function getCoworkOpenAICompatProxyStatus(): OpenAICompatProxyStatus {
  return {
    running: Boolean(proxyServer),
    baseURL: getCoworkOpenAICompatProxyBaseURL(),
    hasUpstream: Boolean(upstreamConfig),
    upstreamBaseURL: upstreamConfig?.baseURL || null,
    upstreamModel: upstreamConfig?.model || null,
    lastError: lastProxyError,
  };
}
