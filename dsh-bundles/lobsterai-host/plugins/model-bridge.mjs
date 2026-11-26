/**
 * @lobsterai/dsh-bundle — Model Bridge Plugin
 *
 * Hot-registers LobsterAI-managed LLM providers and models directly in memory
 * via DSH's `ctx.llm.registerAdapter` + `PiAiAdapter`, avoiding any disk write
 * of API keys to the user's `cordis.patch.yml` or `.credentials.yaml`.
 *
 * Also hooks:
 * - `llm-pi-ai/request-headers`: injects LobsterAI instance header & W3C traceparent
 * - `llm/stream`: resolves virtual model aliases & compatibility adjustments
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import {
  LlmError,
  resolveImageAttachmentAccess,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { DEFAULT_LOBSTER_RETRY_POLICY, guardEmptyStopStream } from './empty-stop-guard.mjs';
import {
  canonicalizeProviderId,
  dispatchProviderStream,
  hasVerifiedModelThinkingLevels,
  lookupBuiltinCatalogModel,
  normalizeProtocol,
  normalizeProviderBaseUrl,
  resolveCatalogProviderCandidates,
  resolveDefaultRequestMaxTokens,
  resolveEffectiveContextWindow,
  resolveModelCompat,
  resolveModelThinkingLevelMap,
  sanitizeExposedModelInfo,
} from './model-bridge-helpers.mjs';
import { getHostState, resolveSessionContext, resolveSessionId } from './shared-state.mjs';

export const name = 'lobster-model-bridge';
export const inject = ['llm'];

const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_IMAGES = 50;
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048;
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;

/** @type {Promise<{ protocols: Record<string, () => unknown>; getBuiltinModel?: (provider: string, modelId: string) => unknown }> | null} */
let piAiRuntimePromise = null;

/**
 * Load pi-ai's lazy protocol factories and built-in model catalog lookup through
 * DSH's profile ESM resolver so the exact installed `@earendil-works/pi-ai`
 * package is used.
 */
async function loadPiAiRuntime() {
  if (!piAiRuntimePromise) {
    piAiRuntimePromise = (async () => {
      const [
        { openAICompletionsApi },
        { openAIResponsesApi },
        { anthropicMessagesApi },
        { googleGenerativeAIApi },
        catalogModule,
      ] = await Promise.all([
        import('@earendil-works/pi-ai/api/openai-completions.lazy'),
        import('@earendil-works/pi-ai/api/openai-responses.lazy'),
        import('@earendil-works/pi-ai/api/anthropic-messages.lazy'),
        import('@earendil-works/pi-ai/api/google-generative-ai.lazy'),
        import('@earendil-works/pi-ai/providers/all').catch(() => null),
      ]);
      return {
        protocols: {
          'openai-completions': openAICompletionsApi,
          'openai-responses': openAIResponsesApi,
          'anthropic-messages': anthropicMessagesApi,
          'google-generative-ai': googleGenerativeAIApi,
        },
        getBuiltinModel: typeof catalogModule?.getBuiltinModel === 'function'
          ? catalogModule.getBuiltinModel
          : undefined,
      };
    })();
  }
  return piAiRuntimePromise;
}

const W3C_TRACE_ID_RE = /^[0-9a-f]{32}$/i;

function buildTraceParent(preferredTraceId) {
  const traceId = typeof preferredTraceId === 'string' && W3C_TRACE_ID_RE.test(preferredTraceId)
    ? preferredTraceId.toLowerCase()
    : randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return `00-${traceId}-${spanId}-01`;
}

function createProviderObject(spec, protocols, modelRuntimeMeta, getRequestContext, ctx, state) {
  /** @type {Map<string, { stream: Function; streamSimple: Function }>} */
  const apiImplCache = new Map();
  const contextWindowsByModel = spec.modelContextWindows ?? new Map();

  const applySessionContextWindow = (model, options, requestContext) => {
    const contextWindows = model?.id ? contextWindowsByModel.get(model.id) : undefined;
    const sid = options?.sessionId ?? requestContext?.sessionId;
    const bound = sid ? resolveSessionContext(ctx, state, sid) : undefined;
    if (!bound || (bound.contextWindowOverride === undefined && bound.contextWindowSelection === undefined)) {
      return { effectiveModel: model, effectiveOptions: options };
    }

    const effectiveContextWindow = resolveEffectiveContextWindow(
      { contextWindow: model.contextWindow, contextWindows },
      bound.contextWindowSelection,
      bound.contextWindowOverride,
    );
    if (effectiveContextWindow === model.contextWindow) {
      return { effectiveModel: model, effectiveOptions: options };
    }

    const clampedMaxTokens = Math.min(model.maxTokens, effectiveContextWindow);
    const effectiveModel = {
      ...model,
      contextWindow: effectiveContextWindow,
      maxTokens: clampedMaxTokens,
    };
    const effectiveOptions = typeof options?.maxTokens === 'number' && options.maxTokens > effectiveContextWindow
      ? { ...options, maxTokens: effectiveContextWindow }
      : options;
    return { effectiveModel, effectiveOptions };
  };

  const invokeStream = (method, model, context, options) => {
    const requestContext = getRequestContext();
    const { effectiveModel, effectiveOptions } = applySessionContextWindow(
      model,
      options,
      requestContext,
    );
    return dispatchProviderStream({
      method,
      spec,
      protocols,
      apiImplCache,
      model: effectiveModel,
      context,
      options: effectiveOptions,
      modelRuntimeMeta,
      requestContext,
    });
  };

  return {
    id: spec.provider,
    name: spec.displayName,
    ...(spec.baseURL ? { baseUrl: spec.baseURL } : {}),
    auth: {
      apiKey: {
        name: spec.displayName,
        resolve: ({ credential }) => Promise.resolve({
          auth: credential?.key === undefined ? {} : { apiKey: credential.key },
          source: spec.displayName,
        }),
      },
    },
    getModels: () => spec.models,
    stream: (model, context, options) => invokeStream('stream', model, context, options),
    streamSimple: (model, context, options) => invokeStream('streamSimple', model, context, options),
  };
}

/**
 * Normalize one incoming LobsterAI provider definition into the exact
 * resolved profile shape consumed by `PiAiAdapter`.
 */
function buildResolvedProfile(entry, protocols, getBuiltinModel, getRequestContext, ctx, state) {
  const provider = canonicalizeProviderId(String(entry.id || ''));
  if (!provider) {
    throw new Error('lobster-model-bridge: provider id must be non-empty');
  }
  const displayName = String(entry.displayName || provider).trim() || provider;
  const api = normalizeProtocol(entry.api);
  const rawBaseURL = typeof entry.baseURL === 'string' && entry.baseURL.trim().length > 0
    ? entry.baseURL.trim()
    : '';
  const baseURL = rawBaseURL ? normalizeProviderBaseUrl(rawBaseURL, api) : undefined;
  if (!protocols[api]) {
    throw new Error(`lobster-model-bridge: unsupported protocol "${api}" for provider "${provider}"`);
  }

  const defaultContextWindow = Number.isInteger(entry.defaultContextWindow) && entry.defaultContextWindow > 0
    ? entry.defaultContextWindow
    : DEFAULT_CONTEXT_WINDOW;
  const defaultMaxTokens = Number.isInteger(entry.defaultMaxTokens) && entry.defaultMaxTokens > 0
    ? entry.defaultMaxTokens
    : DEFAULT_MAX_TOKENS;

  const catalogProviderCandidates = resolveCatalogProviderCandidates(provider, entry.catalogProvider);
  const configuredMaxTokens = new Map();
  const modelRuntimeMeta = new Map();
  /** @type {Set<string>} */
  const verifiedThinkingModels = new Set();
  /** @type {Map<string, Array<{ id: string, label?: string, contextWindow: number }>>} */
  const modelContextWindows = new Map();
  const rawModels = Array.isArray(entry.models) ? entry.models : [];
  const models = [];
  for (const rawModel of rawModels) {
    if (!rawModel || typeof rawModel !== 'object') continue;
    const modelId = String(rawModel.id || '').trim();
    if (!modelId) continue;
    const modelApi = rawModel.api ? normalizeProtocol(rawModel.api) : api;
    if (!protocols[modelApi]) {
      throw new Error(`lobster-model-bridge: unsupported protocol "${modelApi}" for model "${provider}/${modelId}"`);
    }
    const hasExplicitModelBaseUrl = typeof rawModel.baseURL === 'string' && rawModel.baseURL.trim().length > 0;
    const modelBaseUrl = hasExplicitModelBaseUrl
      ? normalizeProviderBaseUrl(rawModel.baseURL, modelApi, api, true)
      : (rawBaseURL ? normalizeProviderBaseUrl(rawBaseURL, modelApi, api, false) : '');
    if (!modelBaseUrl) continue;

    const contextWindow = Number.isInteger(rawModel.contextWindow) && rawModel.contextWindow > 0
      ? rawModel.contextWindow
      : defaultContextWindow;
    const rawMaxTokens = Number.isInteger(rawModel.maxTokens) && rawModel.maxTokens > 0
      ? rawModel.maxTokens
      : defaultMaxTokens;
    const maxTokens = Math.min(rawMaxTokens, contextWindow);
    const explicitMaxTokens = Number.isInteger(rawModel.maxTokens) && rawModel.maxTokens > 0
      ? Math.min(rawModel.maxTokens, contextWindow)
      : undefined;
    const defaultRequestMaxTokens = resolveDefaultRequestMaxTokens(
      rawModel.defaultMaxTokens,
      explicitMaxTokens,
      contextWindow,
    );
    if (defaultRequestMaxTokens !== undefined) {
      configuredMaxTokens.set(modelId, defaultRequestMaxTokens);
    }

    let customParams;
    if (rawModel.customParams && typeof rawModel.customParams === 'object' && !Array.isArray(rawModel.customParams)) {
      const cleanedParams = Object.fromEntries(
        Object.entries(rawModel.customParams).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(cleanedParams).length > 0) {
        customParams = cleanedParams;
      }
    }

    if (Array.isArray(rawModel.contextWindows) && rawModel.contextWindows.length > 0) {
      const validWindows = rawModel.contextWindows
        .filter((w) => w && typeof w === 'object' && typeof w.id === 'string' && Number.isInteger(w.contextWindow) && w.contextWindow > 0)
        .map((w) => ({
          id: w.id,
          ...(typeof w.label === 'string' ? { label: w.label } : {}),
          contextWindow: w.contextWindow,
        }));
      if (validWindows.length > 0) {
        modelContextWindows.set(modelId, validWindows);
      }
    }

    const input = Array.isArray(rawModel.input) && rawModel.input.length > 0
      ? rawModel.input.filter((m) => m === 'text' || m === 'image')
      : (rawModel.supportsImage ? ['text', 'image'] : ['text']);
    const reasoning = Boolean(rawModel.reasoning || rawModel.supportsThinking);
    const catalogModel = lookupBuiltinCatalogModel(
      getBuiltinModel,
      catalogProviderCandidates,
      modelId,
      modelApi,
    );

    const compat = resolveModelCompat(modelApi, modelBaseUrl, entry.compat, rawModel.compat, api);
    const thinkingLevelMap = resolveModelThinkingLevelMap(rawModel, reasoning, catalogModel);
    if (hasVerifiedModelThinkingLevels(rawModel, reasoning, catalogModel)) {
      verifiedThinkingModels.add(modelId);
    }

    const runtimeProfile = typeof rawModel.runtimeProfile === 'string' && rawModel.runtimeProfile.trim().length > 0
      ? rawModel.runtimeProfile.trim()
      : undefined;
    const thinkingConfig = rawModel.thinkingConfig && typeof rawModel.thinkingConfig === 'object'
      ? rawModel.thinkingConfig
      : undefined;
    const requestOptionsVersion = rawModel.requestOptionsVersion === 1 ? 1 : undefined;
    if (runtimeProfile || thinkingConfig || requestOptionsVersion !== undefined || customParams) {
      modelRuntimeMeta.set(modelId, {
        ...(runtimeProfile ? { runtimeProfile } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
        ...(requestOptionsVersion !== undefined ? { requestOptionsVersion } : {}),
        ...(customParams ? { customParams } : {}),
      });
    }

    models.push({
      id: modelId,
      name: String(rawModel.name || modelId),
      api: modelApi,
      provider,
      baseUrl: modelBaseUrl,
      input: input.length > 0 ? input : ['text'],
      cost: NO_COST,
      contextWindow,
      maxTokens,
      reasoning,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      ...(Object.keys(compat).length > 0 ? { compat } : {}),
    });
  }

  const headers = entry.headers && typeof entry.headers === 'object'
    ? Object.fromEntries(
      Object.entries(entry.headers).filter(
        ([k, v]) => typeof k === 'string' && k.length > 0 && typeof v === 'string',
      ),
    )
    : undefined;

  const piProvider = createProviderObject(
    { provider, displayName, api, baseURL, models, modelContextWindows },
    protocols,
    modelRuntimeMeta,
    getRequestContext,
    ctx,
    state,
  );

  const maxRequestImages = Number.isInteger(entry.maxRequestImages) && entry.maxRequestImages > 0
    ? entry.maxRequestImages
    : DEFAULT_MAX_REQUEST_IMAGES;

  return {
    provider,
    displayName,
    api,
    ...(baseURL ? { baseURL } : {}),
    ...(headers ? { headers } : {}),
    ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
    ...(entry.thinkingBudgets ? { thinkingBudgets: entry.thinkingBudgets } : {}),
    ...(entry.cacheRetention ? { cacheRetention: entry.cacheRetention } : {}),
    ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
    streamIdleTimeoutMs: Number.isFinite(entry.streamIdleTimeoutMs) && entry.streamIdleTimeoutMs > 0
      ? entry.streamIdleTimeoutMs
      : DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    maxRequestImages,
    imageOffloadCountQuantum: Math.min(10, maxRequestImages),
    requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(
      entry.retryPolicy ?? DEFAULT_LOBSTER_RETRY_POLICY,
      `lobster-model-bridge: "${provider}"`,
    ),
    configuredMaxTokens,
    verifiedThinkingModels,
    modelErrors: new Map(),
    piProvider,
  };
}

async function* runIterableInRequestContext(requestContextStorage, reqCtx, createIterable) {
  const iterable = requestContextStorage.run(reqCtx, createIterable);
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      const step = await requestContextStorage.run(reqCtx, () => iterator.next());
      if (step.done) return step.value;
      yield step.value;
    }
  } finally {
    if (typeof iterator.return === 'function') {
      await requestContextStorage.run(reqCtx, () => iterator.return()).catch(() => undefined);
    }
  }
}

export function apply(ctx) {
  const state = getHostState(ctx);
  /** @type {AsyncLocalStorage<{ provider?: string; model?: string; reasoningEffort?: string; purpose?: string; sessionId?: string }>} */
  const requestContextStorage = new AsyncLocalStorage();
  const getRequestContext = () => requestContextStorage.getStore();
  /** @type {Map<string, ReturnType<typeof buildResolvedProfile>>} */
  let currentProfiles = new Map();
  /** @type {Map<string, string>} */
  const apiKeys = new Map();
  /** @type {Map<string, { provider: string, model: string }>} */
  const virtualAliases = new Map();
  /** @type {((() => void) & { replace: (routes: string[]) => void }) | undefined} */
  let registration;

  const emptyAuth = {
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => undefined,
      delete: async () => undefined,
    },
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  };

  const adapter = new PiAiAdapter({
    profiles: () => currentProfiles,
    resolveApiKey: async (provider) => {
      const key = apiKeys.get(provider);
      if (key !== undefined && key.length > 0) return key;
      // Allow keyless local/proxy endpoints (e.g. Ollama / local modelAuthProxy)
      // by returning a non-empty placeholder only when the route explicitly set
      // allowEmptyKey, otherwise signal missing credential cleanly.
      const profile = currentProfiles.get(provider);
      if (profile?.baseURL && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(profile.baseURL)) {
        return 'lobsterai-local-proxy';
      }
      throw new LlmError(
        `lobster-model-bridge: no API key synced for provider "${provider}"`,
        'MISSING_CREDENTIAL',
      );
    },
    auth: emptyAuth,
    prepareHeaders: (request, headers) =>
      ctx.waterfall('llm-pi-ai/request-headers', request, headers, () => headers),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
        ref,
      ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `[LobsterAI:ModelBridge] replay state degraded for "${provider}/${model}": ${reason}`,
      );
    },
    onThinkingOmitted: ({ provider, model, count }) => {
      ctx.logger.debug(
        `[LobsterAI:ModelBridge] omitted stale thinking from ${count} message(s) on "${provider}/${model}"`,
      );
    },
  });

  // Preserve the raw DSH `GenerateOptions.reasoningEffort` (including `'off'` vs
  // `undefined`) across `PiAiAdapter` into the provider stream wrapper so
  // `lobsterai_options.thinking.level` reflects explicit `'off'` choices accurately.
  const rawAdapterStream = adapter.stream.bind(adapter);
  adapter.stream = (options) => {
    const reqCtx = {
      provider: options?.provider,
      model: options?.model,
      reasoningEffort: options?.reasoningEffort,
      purpose: options?.purpose,
      sessionId: options?.sessionId,
    };
    return runIterableInRequestContext(requestContextStorage, reqCtx, () => rawAdapterStream(options));
  };

  const isModelThinkingVerified = (provider, model) => {
    const canonical = canonicalizeProviderId(provider);
    return Boolean(currentProfiles.get(canonical)?.verifiedThinkingModels?.has(model));
  };

  const rawAdapterResolveModel = adapter.resolveModel.bind(adapter);
  adapter.resolveModel = async (provider, model, signal) => {
    const verified = isModelThinkingVerified(provider, model);
    const info = await rawAdapterResolveModel(provider, model, signal);
    return sanitizeExposedModelInfo(info, verified);
  };

  const rawAdapterPrepareCall = adapter.prepareCall.bind(adapter);
  adapter.prepareCall = async (provider, model, signal) => {
    const verified = isModelThinkingVerified(provider, model);
    const prepared = await rawAdapterPrepareCall(provider, model, signal);
    return {
      ...prepared,
      model: sanitizeExposedModelInfo(prepared.model, verified),
      stream: (options) => {
        const reqCtx = {
          provider: options?.provider ?? provider,
          model: options?.model ?? model,
          reasoningEffort: options?.reasoningEffort,
          purpose: options?.purpose,
          sessionId: options?.sessionId,
        };
        return runIterableInRequestContext(requestContextStorage, reqCtx, () => prepared.stream(options));
      },
    };
  };

  // Inject LobsterAI observability, turn credit traceparent & instance correlation headers on every LLM call.
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    if (state.instanceId) {
      headers.set('x-lobsterai-instance', state.instanceId);
    }
    const sid = resolveSessionId(request);
    const bound = resolveSessionContext(ctx, state, sid);
    if (bound && typeof bound.coworkSessionId === 'string' && bound.coworkSessionId.length > 0) {
      headers.set('x-lobsterai-session', bound.coworkSessionId);
    }
    if (!headers.has('traceparent')) {
      headers.set('traceparent', buildTraceParent(bound?.traceId));
    }
    return next();
  });

  // Support virtual model alias resolution (e.g. yd-fast / yd-ultra) and guard
  // against premature reasoning-only / empty-content `stop` completions so DSH's
  // `llm-retry` automatically retries instead of ending the turn blank.
  ctx.on('llm/stream', (options, next) => {
    const aliasKey = `${options.provider}/${options.model}`;
    const target = virtualAliases.get(aliasKey) ?? virtualAliases.get(options.model);
    if (target && (target.provider !== options.provider || target.model !== options.model)) {
      return ctx.llm.stream({
        ...options,
        provider: target.provider,
        model: target.model,
      });
    }
    return guardEmptyStopStream(next(), options, ctx.logger);
  });

  state.syncProviders = async (payload) => {
    const body = payload && typeof payload === 'object' ? payload : {};
    const providersList = Array.isArray(body.providers) ? body.providers : [];
    const { protocols, getBuiltinModel } = await loadPiAiRuntime();

    const nextProfiles = new Map();
    const nextKeys = new Map();
    const existingProviders = new Set(ctx.llm.listProviders().map((p) => p.id));
    const ownedRoutes = new Set(currentProfiles.keys());

    const skippedConflicts = [];
    for (const entry of providersList) {
      if (!entry || typeof entry !== 'object') continue;
      const id = canonicalizeProviderId(String(entry.id || ''));
      if (!id) continue;
      // Never collide with an adapter owned by another plugin (e.g. deepseek-official).
      if (existingProviders.has(id) && !ownedRoutes.has(id)) {
        skippedConflicts.push(id);
        continue;
      }
      const resolved = buildResolvedProfile(
        { ...entry, id },
        protocols,
        getBuiltinModel,
        getRequestContext,
        ctx,
        state,
      );
      nextProfiles.set(id, resolved);
      if (typeof entry.apiKey === 'string' && entry.apiKey.length > 0) {
        nextKeys.set(id, entry.apiKey);
      }
    }

    // Update virtual aliases atomically.
    virtualAliases.clear();
    if (body.virtualAliases && typeof body.virtualAliases === 'object') {
      for (const [alias, target] of Object.entries(body.virtualAliases)) {
        if (
          target
          && typeof target === 'object'
          && typeof target.provider === 'string'
          && typeof target.model === 'string'
        ) {
          const canonicalTargetProvider = canonicalizeProviderId(target.provider);
          if (canonicalTargetProvider) {
            virtualAliases.set(alias, { provider: canonicalTargetProvider, model: target.model });
          }
        }
      }
    }

    // Commit profiles & keys before registering routes so PiAiAdapter.providerInfo() sees them.
    currentProfiles = nextProfiles;
    apiKeys.clear();
    for (const [k, v] of nextKeys) apiKeys.set(k, v);
    state.resetWebSearchCooldown?.();

    const routes = [...currentProfiles.keys()];
    if (routes.length === 0) {
      if (registration) {
        registration();
        registration = undefined;
      }
    } else if (!registration) {
      registration = ctx.llm.registerAdapter(routes, adapter);
    } else {
      registration.replace(routes);
    }

    return {
      registeredRoutes: routes,
      skippedConflicts,
      modelCount: [...currentProfiles.values()].reduce(
        (sum, p) => sum + p.piProvider.getModels().length,
        0,
      ),
    };
  };

  state.getProviderAuth = (providerId) => {
    if (typeof providerId !== 'string' || providerId.trim().length === 0) return null;
    const canonical = canonicalizeProviderId(providerId);
    if (!canonical) return null;
    const profile = currentProfiles.get(canonical);
    const apiKey = apiKeys.get(canonical) ?? '';
    if (!profile && !apiKey) return null;
    return {
      apiKey,
      baseURL: typeof profile?.baseURL === 'string' ? profile.baseURL : '',
      api: typeof profile?.api === 'string' ? profile.api : '',
    };
  };

  ctx.effect(() => () => {
    if (registration) {
      registration();
      registration = undefined;
    }
    state.syncProviders = null;
    state.getProviderAuth = null;
    state.pluginsReady.modelBridge = false;
  }, 'lobster-model-bridge cleanup');

  state.pluginsReady.modelBridge = true;
}
