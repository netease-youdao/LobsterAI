/**
 * @lobsterai/dsh-bundle — Unified Web Search Bridge Plugin
 *
 * Registers a single `ctx.web` search provider (`lobster-web-search`) that
 * serves DSH's native `web_search` tool across all model routes:
 *
 * 1. Personal DeepSeek official API key routes (`api.deepseek.com`, excluding
 *    LobsterAI plan provider `lobsterai-server` and third-party relays) try
 *    DeepSeek native server-side Messages search (`web_search_20250305`) first
 *    using the in-memory API key from `lobster-model-bridge`, and fall back
 *    transparently to LobsterAI's in-app browser search on failure.
 * 2. All LobsterAI plan models (including plan DeepSeek) and all non-DeepSeek
 *    custom models route directly to Electron main's authenticated local bridge
 *    (`/dsh-bridge/web-search` -> `WebSearchHost`).
 * 3. Tool admission (`ready`) and execution honor both the global `web-search`
 *    skill switch and per-agent `allowedSkillIds`, plus `blockedHostnames`.
 */

import { WebError } from '@deepseek-ai/dsh-web';
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekSearchProvider,
} from '@deepseek-ai/dsh-web-search-deepseek';
import {
  callLobsterBridge,
  getHostState,
  resolveSessionContext,
  resolveSessionId,
} from './shared-state.mjs';
import {
  DEFAULT_DEEPSEEK_FALLBACK_COOLDOWN_MS,
  filterSearchSourcesByPolicy,
  isBrowserSearchAvailable,
  isSearchAbortError,
  isUnifiedWebSearchReady,
  isWebSearchEnabledByPolicy,
  LOBSTER_WEB_SEARCH_BRIDGE_PATH,
  LOBSTER_WEB_SEARCH_PROVIDER_ID,
  resolveDeepSeekNativeSearchTarget,
  shouldCooldownDeepSeekNativeError,
} from './web-search-bridge-helpers.mjs';

export const name = 'lobster-web-search-bridge';
export const inject = ['web'];

export function apply(ctx) {
  const state = getHostState(ctx);
  /** @type {Map<string, number>} */
  const deepSeekCooldownUntil = new Map();

  state.resetWebSearchCooldown = () => {
    deepSeekCooldownUntil.clear();
  };

  function resolveCurrentBoundContext() {
    const initiator = ctx.get('agents')?.currentInitiator?.();
    const sessionId = resolveSessionId(initiator);
    return {
      initiator,
      bound: sessionId ? resolveSessionContext(ctx, state, sessionId) : undefined,
    };
  }

  async function runDeepSeekNativeSearch(target, request, signal) {
    const provider = new DeepSeekSearchProvider(() => ({
      apiKey: target.apiKey,
      baseURL: target.baseURL,
      model: DEEPSEEK_DEFAULT_MODEL,
      apiVersion: DEEPSEEK_DEFAULT_API_VERSION,
      maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
      maxUses: DEEPSEEK_DEFAULT_MAX_USES,
      recordRequest: (recorded) => {
        ctx.get('agents')?.currentInitiator?.()?.session?.append?.(
          'web/deepseek-search-llm-request',
          recorded,
        );
      },
    }));
    const raw = await provider.search(request, signal);
    return {
      ...raw,
      sources: filterSearchSourcesByPolicy(raw.sources, state.webAccessPolicy.blockedHostnames),
    };
  }

  async function runBrowserBridgeSearch(request, signal) {
    if (signal?.aborted) {
      throw new WebError('Web search aborted', 'WEB_ABORTED', { cause: signal.reason });
    }
    let response;
    try {
      response = await callLobsterBridge(
        state,
        LOBSTER_WEB_SEARCH_BRIDGE_PATH,
        {
          query: request.query,
          ...(typeof request.maxResults === 'number' ? { maxResults: request.maxResults } : {}),
        },
        signal,
      );
    } catch (error) {
      if (isSearchAbortError(error, signal)) {
        throw new WebError('Web search aborted', 'WEB_ABORTED', { cause: error });
      }
      throw new WebError(
        `LobsterAI in-app web search bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      );
    }

    if (signal?.aborted) {
      throw new WebError('Web search aborted', 'WEB_ABORTED', { cause: signal.reason });
    }
    if (!response.available) {
      throw new WebError(
        response.error || 'LobsterAI in-app web search bridge is unavailable.',
        'WEB_PROVIDER_UNAVAILABLE',
      );
    }
    if (!response.ok) {
      throw new WebError(
        response.error || 'LobsterAI in-app web search failed.',
        'WEB_PROVIDER_ERROR',
      );
    }

    const payload = response.data && typeof response.data === 'object'
      ? /** @type {Record<string, unknown>} */ (response.data)
      : {};
    const sources = filterSearchSourcesByPolicy(
      payload.sources,
      state.webAccessPolicy.blockedHostnames,
    );
    return { sources, truncated: false };
  }

  const disposeProvider = ctx.web.registerSearchProvider({
    id: LOBSTER_WEB_SEARCH_PROVIDER_ID,
    title: {
      en: 'LobsterAI Web Search',
      zh: 'LobsterAI 联网搜索',
    },
    description: {
      en: 'Uses DeepSeek native search for personal official DeepSeek API keys (with automatic fallback) and LobsterAI in-app browser search for all other models.',
      zh: '个人官方 DeepSeek API Key 优先走 DeepSeek 原生搜索（失败自动回退），套餐及其他模型直接走内置浏览器搜索。',
    },
    // Always remain selectable in ctx.web so `ready()` cleanly controls tool
    // visibility (`dsh-web` treats selection failure as ready=true).
    available: () => true,
    ready: async (llmProvider) => {
      const { bound } = resolveCurrentBoundContext();
      const providerAuth = typeof state.getProviderAuth === 'function'
        ? state.getProviderAuth(llmProvider)
        : null;
      return isUnifiedWebSearchReady({
        llmProvider,
        providerAuth,
        skillsPolicy: state.skillsPolicy,
        allowedSkillIds: bound?.allowedSkillIds,
        searchPolicy: state.searchPolicy,
        browserSearchEnabled: state.webAccessPolicy.browserSearchEnabled,
        bridgeUrl: state.bridgeUrl,
        deepseekSearchBaseUrl: state.webAccessPolicy.deepseekSearchBaseUrl,
      });
    },
    search: async (request, signal) => {
      if (signal?.aborted) {
        throw new WebError('Web search aborted', 'WEB_ABORTED', { cause: signal.reason });
      }
      const { initiator, bound } = resolveCurrentBoundContext();
      if (!isWebSearchEnabledByPolicy(state.skillsPolicy, bound?.allowedSkillIds)) {
        throw new WebError(
          'web_search is disabled by LobsterAI web-search skill policy.',
          'WEB_PROVIDER_UNAVAILABLE',
        );
      }

      const llmProvider = request.llmProvider
        ?? initiator?.session?.requestContext?.()?.provider;
      const providerAuth = typeof state.getProviderAuth === 'function'
        ? state.getProviderAuth(llmProvider)
        : null;
      const nativeTarget = resolveDeepSeekNativeSearchTarget({
        llmProvider,
        providerAuth,
        searchPolicy: state.searchPolicy,
        deepseekSearchBaseUrl: state.webAccessPolicy.deepseekSearchBaseUrl,
      });
      const canUseBrowser = isBrowserSearchAvailable({
        searchPolicy: state.searchPolicy,
        browserSearchEnabled: state.webAccessPolicy.browserSearchEnabled,
        bridgeUrl: state.bridgeUrl,
      });

      let nativeFailure;
      if (nativeTarget) {
        const cooldownKey = `${String(llmProvider || '').toLowerCase()}|${nativeTarget.baseURL}`;
        const cooledDown = Date.now() < (deepSeekCooldownUntil.get(cooldownKey) ?? 0);
        if (!cooledDown || !canUseBrowser) {
          try {
            const result = await runDeepSeekNativeSearch(nativeTarget, request, signal);
            deepSeekCooldownUntil.delete(cooldownKey);
            return result;
          } catch (error) {
            if (isSearchAbortError(error, signal)) {
              throw error instanceof WebError
                ? error
                : new WebError('Web search aborted', 'WEB_ABORTED', { cause: error });
            }
            if (shouldCooldownDeepSeekNativeError(error)) {
              deepSeekCooldownUntil.set(
                cooldownKey,
                Date.now() + DEFAULT_DEEPSEEK_FALLBACK_COOLDOWN_MS,
              );
            }
            if (!canUseBrowser) {
              throw error instanceof WebError
                ? error
                : new WebError(
                    error instanceof Error ? error.message : String(error),
                    'WEB_PROVIDER_ERROR',
                    { cause: error },
                  );
            }
            nativeFailure = error;
            ctx.logger.warn(
              `[LobsterAI:WebSearch] DeepSeek native search failed for "${String(llmProvider)}", falling back to in-app browser search: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      if (!canUseBrowser) {
        throw new WebError(
          'LobsterAI web search is not available for the active model route.',
          'WEB_PROVIDER_UNAVAILABLE',
        );
      }

      try {
        return await runBrowserBridgeSearch(request, signal);
      } catch (browserError) {
        if (isSearchAbortError(browserError, signal)) {
          throw browserError instanceof WebError
            ? browserError
            : new WebError('Web search aborted', 'WEB_ABORTED', { cause: browserError });
        }
        if (nativeFailure) {
          const nativeMsg = nativeFailure instanceof Error ? nativeFailure.message : String(nativeFailure);
          const browserMsg = browserError instanceof Error ? browserError.message : String(browserError);
          throw new WebError(
            `DeepSeek native search failed (${nativeMsg}) and in-app browser fallback also failed (${browserMsg})`,
            'WEB_PROVIDER_ERROR',
            { cause: browserError },
          );
        }
        throw browserError;
      }
    },
  });

  ctx.effect(() => () => {
    disposeProvider();
    deepSeekCooldownUntil.clear();
    state.resetWebSearchCooldown = null;
    state.pluginsReady.webSearchBridge = false;
  }, 'lobster-web-search-bridge cleanup');

  state.pluginsReady.webSearchBridge = true;
}
