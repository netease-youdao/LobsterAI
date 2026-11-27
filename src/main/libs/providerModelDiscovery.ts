/**
 * Live provider model discovery for Electron main process.
 *
 * Mirrors DSH's `@deepseek-ai/dsh-llm-pi-ai` discovery protocol and response
 * parsing (OpenAI-compatible, Anthropic Messages, Gemini, plus common relay
 * and Copilot/Ollama response extensions) while running over an injectable
 * `fetch` (wired to `session.defaultSession.fetch` in main) so requests always
 * honor LobsterAI's "Use System Proxy" preference (direct vs system/PAC/SOCKS).
 *
 * Zero Electron imports so this module is directly testable under Vitest.
 */

import {
  type DiscoveredModel,
  ModelDiscoveryErrorCode,
  ModelDiscoveryModality,
  normalizeGeminiApiBaseUrl,
  ProviderDiscoveryProtocol,
  type ProviderModelDiscoveryRequest,
  type ProviderModelDiscoveryResult,
  ProviderName,
} from '../../shared/providers';
import { stripOpenAIEndpointSuffix } from './providerSelection';

export type DiscoveryFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface DiscoverProviderModelsOptions {
  fetch: DiscoveryFetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODEL_LIMIT = 1000;
const GEMINI_MODEL_LIMIT = 1000;
export const MAX_MODEL_DISCOVERY_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;
const MAX_ERROR_DETAIL_CHARS = 240;
export const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

// Printable non-whitespace ASCII characters safe for HTTP auth headers.
const LEGAL_API_KEY_RE = /^[\x21-\x7E]+$/;
const LEGAL_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const LEGAL_HEADER_VALUE_RE = /^[\t\x20-\x7E]*$/;
const VERSION_SEGMENT_RE = /\/v\d+(?:(?:alpha|beta)\d*)?$/i;

const RESERVED_AUTH_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'anthropic-version',
  'accept',
]);

const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  ProviderDiscoveryProtocol.OpenAICompletions,
  ProviderDiscoveryProtocol.OpenAIResponses,
  ProviderDiscoveryProtocol.AnthropicMessages,
  ProviderDiscoveryProtocol.GoogleGenerativeAI,
]);

interface ListingLimit {
  context?: unknown;
  output?: unknown;
}

interface ListingTopProvider {
  context_length?: unknown;
  max_completion_tokens?: unknown;
}

interface ListingArchitecture {
  input_modalities?: unknown;
}

interface ListingCapabilitiesLimits {
  max_context_window_tokens?: unknown;
  max_output_tokens?: unknown;
}

interface ListingCapabilitiesSupports {
  vision?: unknown;
  reasoning?: unknown;
  thinking?: unknown;
}

interface ListingCapabilities {
  limits?: ListingCapabilitiesLimits | null;
  supports?: ListingCapabilitiesSupports | null;
  reasoning?: unknown;
  thinking?: unknown;
}

interface ListingModalities {
  input?: unknown;
}

interface ListingEntry {
  id?: unknown;
  model?: unknown;
  name?: unknown;
  display_name?: unknown;
  displayName?: unknown;
  contextWindow?: unknown;
  context_window?: unknown;
  context_length?: unknown;
  max_input_tokens?: unknown;
  maxOutputTokens?: unknown;
  max_output_tokens?: unknown;
  maxTokens?: unknown;
  max_tokens?: unknown;
  limit?: ListingLimit | null;
  top_provider?: ListingTopProvider | null;
  architecture?: ListingArchitecture | null;
  capabilities?: ListingCapabilities | null;
  modalities?: ListingModalities | null;
  inputModalities?: unknown;
  input_modalities?: unknown;
  reasoning?: unknown;
  thinking?: unknown;
  supports_reasoning?: unknown;
  supportsThinking?: unknown;
  supported_parameters?: unknown;
}

interface GeminiListingEntry {
  name?: unknown;
  displayName?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
  supportedGenerationMethods?: unknown;
}

class DiscoveryFailure extends Error {
  readonly code: ModelDiscoveryErrorCode;
  readonly status?: number;
  readonly detail?: string;

  constructor(
    code: ModelDiscoveryErrorCode,
    message: string,
    status?: number,
    detail?: string,
  ) {
    super(message);
    this.name = 'DiscoveryFailure';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function readPositiveInt(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return undefined;
}

function readLabel(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

function readInputModalities(entry: ListingEntry | null): ModelDiscoveryModality[] | undefined {
  if (!entry || typeof entry !== 'object') return undefined;

  const rawLists = [
    entry.inputModalities,
    entry.input_modalities,
    entry.architecture?.input_modalities,
    entry.modalities?.input,
  ];
  for (const rawList of rawLists) {
    if (!Array.isArray(rawList)) continue;
    const modalities: ModelDiscoveryModality[] = [];
    for (const item of rawList) {
      if (typeof item !== 'string') continue;
      const lower = item.trim().toLowerCase();
      if (lower === ModelDiscoveryModality.Text && !modalities.includes(ModelDiscoveryModality.Text)) {
        modalities.push(ModelDiscoveryModality.Text);
      } else if (
        (lower === ModelDiscoveryModality.Image || lower === 'vision')
        && !modalities.includes(ModelDiscoveryModality.Image)
      ) {
        modalities.push(ModelDiscoveryModality.Image);
      }
    }
    if (modalities.length > 0) {
      if (!modalities.includes(ModelDiscoveryModality.Text)) {
        modalities.unshift(ModelDiscoveryModality.Text);
      }
      return modalities;
    }
  }

  if (entry.capabilities?.supports?.vision === true) {
    return [ModelDiscoveryModality.Text, ModelDiscoveryModality.Image];
  }

  return undefined;
}

function readReasoningSupport(entry: ListingEntry | null): boolean | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  if (
    entry.reasoning === true
    || entry.thinking === true
    || entry.supports_reasoning === true
    || entry.supportsThinking === true
    || entry.capabilities?.reasoning === true
    || entry.capabilities?.thinking === true
    || entry.capabilities?.supports?.reasoning === true
    || entry.capabilities?.supports?.thinking === true
  ) {
    return true;
  }
  if (Array.isArray(entry.supported_parameters)) {
    const supportsReasoningParam = entry.supported_parameters.some(
      (param) => param === 'reasoning' || param === 'include_reasoning' || param === 'thinking',
    );
    if (supportsReasoningParam) return true;
  }
  return undefined;
}

function validateHttpBaseUrl(rawBaseUrl: string): URL {
  const trimmed = rawBaseUrl.trim();
  if (!trimmed) {
    throw new DiscoveryFailure(
      ModelDiscoveryErrorCode.InvalidBaseUrl,
      'Base URL is required to fetch available models',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new DiscoveryFailure(
      ModelDiscoveryErrorCode.InvalidBaseUrl,
      `Invalid base URL: "${trimmed}"`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DiscoveryFailure(
      ModelDiscoveryErrorCode.InvalidBaseUrl,
      `Unsupported URL protocol "${parsed.protocol}"; expected http: or https:`,
    );
  }
  return parsed;
}

function stripTrailingQueryAndHash(rawBaseUrl: string): string {
  const parsed = validateHttpBaseUrl(rawBaseUrl);
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

function stripAnthropicEndpointSuffix(rawBaseUrl: string): string {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return normalized;
  return normalized
    .replace(/\/v1\/messages$/i, '')
    .replace(/\/messages$/i, '')
    .replace(/\/+$/, '');
}

function stripTrailingModelsSegment(rawBaseUrl: string): string {
  const normalized = rawBaseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return normalized;
  return normalized.replace(/\/models$/i, '').replace(/\/+$/, '');
}

/**
 * Build the ordered list of candidate model-listing URLs for a provider draft.
 * The first URL is probed first; subsequent URLs are tried only when the
 * preceding request returns HTTP 404 (e.g. a user omitted `/v1` on an
 * OpenAI-compatible server or Ollama).
 */
export function buildModelDiscoveryUrls(
  rawBaseUrl: string,
  apiProtocol: ProviderDiscoveryProtocol,
  provider?: string,
): string[] {
  const cleanBase = stripTrailingQueryAndHash(rawBaseUrl);

  if (apiProtocol === ProviderDiscoveryProtocol.GoogleGenerativeAI) {
    const geminiRoot = normalizeGeminiApiBaseUrl(cleanBase);
    return [`${geminiRoot}/models?pageSize=${String(GEMINI_MODEL_LIMIT)}`];
  }

  if (apiProtocol === ProviderDiscoveryProtocol.AnthropicMessages) {
    const withoutEndpoint = stripTrailingModelsSegment(stripAnthropicEndpointSuffix(cleanBase));
    const root = withoutEndpoint.endsWith('/v1')
      ? withoutEndpoint.slice(0, -3)
      : withoutEndpoint;
    const urls = [`${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`];
    if (provider === ProviderName.Ollama) {
      urls.push(`${root}/api/tags`);
    }
    return urls;
  }

  // OpenAI Completions / OpenAI Responses
  const openAiBase = stripTrailingModelsSegment(stripOpenAIEndpointSuffix(cleanBase));
  const urls = [`${openAiBase}/models`];

  const openAiPath = new URL(openAiBase).pathname.replace(/\/+$/, '');
  if (!VERSION_SEGMENT_RE.test(openAiPath)) {
    urls.push(`${openAiBase}/v1/models`);
  }

  if (provider === ProviderName.Ollama) {
    const ollamaRoot = openAiBase.endsWith('/v1')
      ? openAiBase.slice(0, -3)
      : openAiBase;
    urls.push(`${ollamaRoot}/api/tags`);
  }

  return [...new Set(urls)];
}

export function normalizeDiscoveryApiKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!LEGAL_API_KEY_RE.test(trimmed)) {
    throw new DiscoveryFailure(
      ModelDiscoveryErrorCode.InvalidApiKey,
      'API key contains characters that cannot be sent in an HTTP header',
    );
  }
  return trimmed;
}

function buildDiscoveryHeaders(
  apiProtocol: ProviderDiscoveryProtocol,
  apiKey: string | undefined,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (typeof key !== 'string' || typeof value !== 'string') continue;
      const trimmedKey = key.trim();
      const trimmedValue = value.trim();
      if (!trimmedKey || RESERVED_AUTH_HEADERS.has(trimmedKey.toLowerCase())) continue;
      if (!LEGAL_HEADER_NAME_RE.test(trimmedKey) || !LEGAL_HEADER_VALUE_RE.test(trimmedValue)) continue;
      headers[trimmedKey] = trimmedValue;
    }
  }

  headers.Accept = 'application/json';

  if (apiProtocol === ProviderDiscoveryProtocol.AnthropicMessages) {
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    if (apiKey !== undefined) {
      headers['x-api-key'] = apiKey;
    }
  } else if (apiProtocol === ProviderDiscoveryProtocol.GoogleGenerativeAI) {
    if (apiKey !== undefined) {
      headers['x-goog-api-key'] = apiKey;
    }
  } else if (apiKey !== undefined) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

async function readErrorDetail(response: Response): Promise<string | undefined> {
  try {
    let rawText = '';
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const remaining = MAX_ERROR_BODY_BYTES - total;
          if (remaining <= 0) break;
          const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
          chunks.push(slice);
          total += slice.byteLength;
          if (total >= MAX_ERROR_BODY_BYTES) break;
        }
      } finally {
        await reader.cancel().catch((): void => undefined);
      }
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      rawText = new TextDecoder().decode(combined);
    } else {
      rawText = (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);
    }

    const trimmed = rawText.trim();
    if (!trimmed) return undefined;

    let extracted: string | undefined;
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: { message?: unknown } | string;
        message?: unknown;
        detail?: unknown;
      };
      if (typeof parsed?.error === 'string') {
        extracted = parsed.error;
      } else if (parsed?.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') {
        extracted = parsed.error.message;
      } else if (typeof parsed?.message === 'string') {
        extracted = parsed.message;
      } else if (typeof parsed?.detail === 'string') {
        extracted = parsed.detail;
      }
    } catch {
      // Non-JSON error bodies (e.g. HTML gateway pages) are not shown verbatim.
      if (!trimmed.startsWith('<')) {
        extracted = trimmed;
      }
    }

    const cleaned = extracted?.replace(/\s+/g, ' ').trim();
    if (!cleaned) return undefined;
    return cleaned.length > MAX_ERROR_DETAIL_CHARS
      ? `${cleaned.slice(0, MAX_ERROR_DETAIL_CHARS)}...`
      : cleaned;
  } catch {
    return undefined;
  }
}

async function readBoundedResponseText(response: Response, url: string): Promise<string> {
  const oversized = (): DiscoveryFailure => new DiscoveryFailure(
    ModelDiscoveryErrorCode.ResponseTooLarge,
    `${url} answered with more than ${MAX_MODEL_DISCOVERY_RESPONSE_BYTES} bytes`,
  );

  const declared = Number(response.headers?.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_MODEL_DISCOVERY_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch((): void => undefined);
    throw oversized();
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_MODEL_DISCOVERY_RESPONSE_BYTES) {
      throw oversized();
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_MODEL_DISCOVERY_RESPONSE_BYTES) {
        throw oversized();
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch((): void => undefined);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * Parse OpenAI-compatible, Anthropic Messages, enriched gateway map, or
 * array-under-`models` (e.g. Ollama `/api/tags`) listing replies.
 */
export function parseOpenAIOrAnthropicListing(body: unknown): DiscoveredModel[] {
  const listing = body && typeof body === 'object'
    ? body as { data?: unknown; models?: unknown }
    : null;

  let listed: Array<{ readonly key?: string; readonly raw: unknown }>;
  if (Array.isArray(listing?.data)) {
    listed = listing.data.map((raw) => ({ raw }));
  } else if (Array.isArray(listing?.models)) {
    listed = listing.models.map((raw) => ({ raw }));
  } else if (listing?.models !== null && typeof listing?.models === 'object') {
    listed = Object.entries(listing.models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }));
  } else {
    throw new DiscoveryFailure(
      ModelDiscoveryErrorCode.InvalidFormat,
      'The endpoint model listing has neither a "data" array nor a "models" list/object',
    );
  }

  const models: DiscoveredModel[] = [];
  for (const { key, raw } of listed) {
    const entry = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as ListingEntry
      : null;
    const id = readLabel(key, entry?.id, entry?.model, entry?.name);
    if (id === undefined) continue;
    const name = readLabel(entry?.display_name, entry?.displayName, entry?.name) ?? id;
    const contextWindow = readPositiveInt(
      entry?.contextWindow,
      entry?.context_window,
      entry?.context_length,
      entry?.max_input_tokens,
      entry?.limit?.context,
      entry?.top_provider?.context_length,
      entry?.capabilities?.limits?.max_context_window_tokens,
    );
    const maxTokens = readPositiveInt(
      entry?.maxOutputTokens,
      entry?.max_output_tokens,
      entry?.maxTokens,
      entry?.max_tokens,
      entry?.limit?.output,
      entry?.top_provider?.max_completion_tokens,
      entry?.capabilities?.limits?.max_output_tokens,
    );
    const inputModalities = readInputModalities(entry);
    const reasoning = readReasoningSupport(entry);
    models.push({
      id,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(inputModalities === undefined ? {} : { inputModalities }),
      ...(reasoning === undefined ? {} : { reasoning }),
    });
  }

  return models;
}

/**
 * Parse a Gemini `GET /models` reply, skipping entries that declare generation
 * methods without `generateContent` and stripping the leading `models/` prefix.
 */
export function parseGeminiListing(body: unknown): DiscoveredModel[] {
  const listed = body && typeof body === 'object'
    ? (body as { models?: unknown }).models
    : undefined;
  if (!Array.isArray(listed)) {
    throw new DiscoveryFailure(
      ModelDiscoveryErrorCode.InvalidFormat,
      'The Gemini endpoint model listing has no "models" array',
    );
  }

  const models: DiscoveredModel[] = [];
  for (const raw of listed) {
    const entry = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as GeminiListingEntry
      : null;
    const methods = entry?.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes('generateContent')) continue;
    const rawName = readLabel(entry?.name);
    const id = rawName?.replace(/^models\//, '').trim();
    if (!id) continue;
    const contextWindow = readPositiveInt(entry?.inputTokenLimit);
    const maxTokens = readPositiveInt(entry?.outputTokenLimit);
    models.push({
      id,
      name: readLabel(entry?.displayName) ?? id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
  }

  return models;
}

function deduplicateModels(models: readonly DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Set<string>();
  const result: DiscoveredModel[] = [];
  for (const model of models) {
    if (!model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    result.push({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    });
  }
  return result;
}

function createRequestSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Model discovery timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason ?? new Error('Model discovery aborted'));
  };

  if (callerSignal) {
    if (callerSignal.aborted) {
      onCallerAbort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Query a provider's live model-listing endpoint using the supplied `fetch`
 * implementation (in Electron main, `session.defaultSession.fetch`).
 */
export async function discoverProviderModels(
  request: ProviderModelDiscoveryRequest,
  options: DiscoverProviderModelsOptions,
): Promise<ProviderModelDiscoveryResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;

  try {
    if (!LISTABLE_PROTOCOLS.has(request.apiProtocol)) {
      throw new DiscoveryFailure(
        ModelDiscoveryErrorCode.UnsupportedProtocol,
        `Protocol "${String(request.apiProtocol)}" does not support model discovery`,
      );
    }

    const candidateUrls = buildModelDiscoveryUrls(
      request.baseUrl,
      request.apiProtocol,
      request.provider,
    );
    const apiKey = normalizeDiscoveryApiKey(request.apiKey);
    const headers = buildDiscoveryHeaders(request.apiProtocol, apiKey, request.headers);

    const { signal, cleanup } = createRequestSignal(timeoutMs, options.signal);
    try {
      let response: Response | null = null;
      let activeUrl = candidateUrls[0];

      for (let i = 0; i < candidateUrls.length; i += 1) {
        activeUrl = candidateUrls[i];
        try {
          response = await options.fetch(activeUrl, {
            method: 'GET',
            headers,
            credentials: 'omit',
            signal,
          });
        } catch (error) {
          if (signal.aborted) {
            throw new DiscoveryFailure(
              ModelDiscoveryErrorCode.Aborted,
              options.signal?.aborted
                ? 'Model discovery cancelled'
                : `Request to ${activeUrl} timed out`,
            );
          }
          const detail = error instanceof Error ? error.message : String(error);
          throw new DiscoveryFailure(
            ModelDiscoveryErrorCode.NetworkError,
            `Could not reach ${activeUrl}: ${detail}`,
          );
        }

        if (response.status === 404 && i < candidateUrls.length - 1) {
          await response.body?.cancel?.().catch((): void => undefined);
          continue;
        }
        break;
      }

      if (!response) {
        throw new DiscoveryFailure(
          ModelDiscoveryErrorCode.NetworkError,
          'No model discovery endpoint available',
        );
      }

      if (!response.ok) {
        const detail = await readErrorDetail(response);
        const isAuth = response.status === 401 || response.status === 403;
        throw new DiscoveryFailure(
          isAuth ? ModelDiscoveryErrorCode.AuthError : ModelDiscoveryErrorCode.HttpError,
          `${activeUrl} returned HTTP ${response.status}`,
          response.status,
          detail,
        );
      }

      let text: string;
      try {
        text = await readBoundedResponseText(response, activeUrl);
      } catch (error) {
        if (error instanceof DiscoveryFailure) throw error;
        if (signal.aborted) {
          throw new DiscoveryFailure(
            ModelDiscoveryErrorCode.Aborted,
            options.signal?.aborted
              ? 'Model discovery cancelled'
              : `Reading response from ${activeUrl} timed out`,
          );
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new DiscoveryFailure(
          ModelDiscoveryErrorCode.NetworkError,
          `Failed reading response from ${activeUrl}: ${detail}`,
        );
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new DiscoveryFailure(
          ModelDiscoveryErrorCode.InvalidJson,
          `${activeUrl} did not return valid JSON`,
        );
      }

      const rawModels = request.apiProtocol === ProviderDiscoveryProtocol.GoogleGenerativeAI
        ? parseGeminiListing(body)
        : parseOpenAIOrAnthropicListing(body);

      return {
        ok: true,
        models: deduplicateModels(rawModels),
      };
    } finally {
      cleanup();
    }
  } catch (error) {
    if (error instanceof DiscoveryFailure) {
      return {
        ok: false,
        code: error.code,
        ...(error.status === undefined ? {} : { status: error.status }),
        message: error.message,
        ...(error.detail ? { detail: error.detail } : {}),
      };
    }
    return {
      ok: false,
      code: ModelDiscoveryErrorCode.NetworkError,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
