import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test } from 'vitest';

const HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/web-search-bridge-helpers.mjs'),
).href;

type WebSearchBridgeHelpers = {
  DEEPSEEK_SEARCH_DEFAULT_BASE_URL: string;
  isOfficialDeepSeekBaseUrl: (baseURL: unknown) => boolean;
  isWebSearchEnabledByPolicy: (
    skillsPolicy?: { enabledIds?: Set<string> | null; disabledIds?: Set<string> },
    allowedSkillIds?: ReadonlySet<string> | readonly string[] | null,
  ) => boolean;
  resolveDeepSeekNativeSearchTarget: (params: {
    llmProvider?: unknown;
    providerAuth?: { apiKey?: unknown; baseURL?: unknown } | null;
    searchPolicy?: unknown;
    deepseekSearchBaseUrl?: unknown;
  }) => { apiKey: string; baseURL: string } | null;
  isBrowserSearchAvailable: (params: {
    searchPolicy?: unknown;
    browserSearchEnabled?: unknown;
    bridgeUrl?: unknown;
  }) => boolean;
  isUnifiedWebSearchReady: (params: {
    llmProvider?: unknown;
    providerAuth?: { apiKey?: unknown; baseURL?: unknown } | null;
    skillsPolicy?: { enabledIds?: Set<string> | null; disabledIds?: Set<string> };
    allowedSkillIds?: ReadonlySet<string> | readonly string[] | null;
    searchPolicy?: unknown;
    browserSearchEnabled?: unknown;
    bridgeUrl?: unknown;
    deepseekSearchBaseUrl?: unknown;
  }) => boolean;
  filterSearchSourcesByPolicy: (
    rawSources: unknown,
    blockedHostnames?: readonly string[],
  ) => Array<{ url: string; title?: string; snippet?: string; summary?: string; publishedAt?: string }>;
  isSearchAbortError: (error: unknown, signal?: AbortSignal) => boolean;
  shouldCooldownDeepSeekNativeError: (error: unknown) => boolean;
};

let cached: WebSearchBridgeHelpers | null = null;
async function loadHelpers(): Promise<WebSearchBridgeHelpers> {
  if (!cached) {
    cached = (await import(HELPERS_URL)) as WebSearchBridgeHelpers;
  }
  return cached;
}

describe('web-search-bridge-helpers', () => {
  test('matches only official HTTPS api.deepseek.com base URLs', async () => {
    const h = await loadHelpers();

    expect(h.isOfficialDeepSeekBaseUrl('https://api.deepseek.com')).toBe(true);
    expect(h.isOfficialDeepSeekBaseUrl('https://api.deepseek.com/v1')).toBe(true);
    expect(h.isOfficialDeepSeekBaseUrl('https://API.DEEPSEEK.COM/anthropic/v1')).toBe(true);

    expect(h.isOfficialDeepSeekBaseUrl('http://api.deepseek.com/v1')).toBe(false);
    expect(h.isOfficialDeepSeekBaseUrl('https://relay.deepseek.com/v1')).toBe(false);
    expect(h.isOfficialDeepSeekBaseUrl('https://api.deepseek.com.evil.test/v1')).toBe(false);
    expect(h.isOfficialDeepSeekBaseUrl('http://127.0.0.1:41234/v1')).toBe(false);
    expect(h.isOfficialDeepSeekBaseUrl('')).toBe(false);
  });

  test('routes personal official DeepSeek keys to native search and excludes plan models and third-party relays', async () => {
    const h = await loadHelpers();

    // Personal DeepSeek official API key -> native search enabled.
    expect(h.resolveDeepSeekNativeSearchTarget({
      llmProvider: 'deepseek',
      providerAuth: { apiKey: 'sk-personal', baseURL: 'https://api.deepseek.com/v1' },
      searchPolicy: 'allow_all',
    })).toEqual({
      apiKey: 'sk-personal',
      baseURL: h.DEEPSEEK_SEARCH_DEFAULT_BASE_URL,
    });

    // Custom personal provider pointing directly to official api.deepseek.com -> native search enabled.
    expect(h.resolveDeepSeekNativeSearchTarget({
      llmProvider: 'my-deepseek',
      providerAuth: { apiKey: 'sk-personal-2', baseURL: 'https://api.deepseek.com/anthropic' },
      searchPolicy: 'allow_all',
    })).toEqual({
      apiKey: 'sk-personal-2',
      baseURL: h.DEEPSEEK_SEARCH_DEFAULT_BASE_URL,
    });

    // LobsterAI plan provider (shared account) -> MUST NEVER use DeepSeek native search.
    expect(h.resolveDeepSeekNativeSearchTarget({
      llmProvider: 'lobsterai-server',
      providerAuth: { apiKey: 'plan-proxy-token', baseURL: 'http://127.0.0.1:5000/v1' },
      searchPolicy: 'allow_all',
    })).toBeNull();
    expect(h.resolveDeepSeekNativeSearchTarget({
      llmProvider: 'lobsterai-server',
      providerAuth: { apiKey: 'plan-proxy-token', baseURL: 'https://api.deepseek.com/v1' },
      searchPolicy: 'allow_all',
    })).toBeNull();

    // Third-party DeepSeek relay -> MUST route to in-app browser instead of official search.
    expect(h.resolveDeepSeekNativeSearchTarget({
      llmProvider: 'deepseek',
      providerAuth: { apiKey: 'sk-relay', baseURL: 'https://openrouter.ai/api/v1' },
      searchPolicy: 'allow_all',
    })).toBeNull();

    // Non-DeepSeek models or missing keys -> null.
    expect(h.resolveDeepSeekNativeSearchTarget({
      llmProvider: 'openai',
      providerAuth: { apiKey: 'sk-openai', baseURL: 'https://api.openai.com/v1' },
      searchPolicy: 'allow_all',
    })).toBeNull();
    expect(h.resolveDeepSeekNativeSearchTarget({
      llmProvider: 'deepseek',
      providerAuth: { apiKey: '', baseURL: 'https://api.deepseek.com/v1' },
      searchPolicy: 'allow_all',
    })).toBeNull();

    // Explicit kill-switch policy disables native search too.
    expect(h.resolveDeepSeekNativeSearchTarget({
      llmProvider: 'deepseek',
      providerAuth: { apiKey: 'sk-personal', baseURL: 'https://api.deepseek.com/v1' },
      searchPolicy: 'lobster_web_search_only',
    })).toBeNull();
  });

  test('gates unified web_search readiness by global skill policy, per-agent allowlist, and backend availability', async () => {
    const h = await loadHelpers();

    const openPolicy = { enabledIds: null, disabledIds: new Set<string>() };

    // Non-DeepSeek & plan models are ready when in-app bridge is configured.
    expect(h.isUnifiedWebSearchReady({
      llmProvider: 'lobsterai-server',
      skillsPolicy: openPolicy,
      bridgeUrl: 'http://127.0.0.1:41234',
      browserSearchEnabled: true,
    })).toBe(true);

    // Without bridgeUrl or with browserSearchEnabled=false, non-DeepSeek routes are not ready.
    expect(h.isUnifiedWebSearchReady({
      llmProvider: 'openai',
      skillsPolicy: openPolicy,
      bridgeUrl: '',
      browserSearchEnabled: true,
    })).toBe(false);
    expect(h.isUnifiedWebSearchReady({
      llmProvider: 'openai',
      skillsPolicy: openPolicy,
      bridgeUrl: 'http://127.0.0.1:41234',
      browserSearchEnabled: false,
    })).toBe(false);

    // Personal official DeepSeek stays ready even if browser search is unavailable.
    expect(h.isUnifiedWebSearchReady({
      llmProvider: 'deepseek',
      providerAuth: { apiKey: 'sk-ds', baseURL: 'https://api.deepseek.com/v1' },
      skillsPolicy: openPolicy,
      bridgeUrl: '',
      browserSearchEnabled: false,
    })).toBe(true);

    // Global skill disable hides web_search across all routes.
    expect(h.isUnifiedWebSearchReady({
      llmProvider: 'deepseek',
      providerAuth: { apiKey: 'sk-ds', baseURL: 'https://api.deepseek.com/v1' },
      skillsPolicy: { enabledIds: null, disabledIds: new Set(['web-search']) },
      bridgeUrl: 'http://127.0.0.1:41234',
    })).toBe(false);
    expect(h.isUnifiedWebSearchReady({
      llmProvider: 'openai',
      skillsPolicy: { enabledIds: new Set(['docx']), disabledIds: new Set() },
      bridgeUrl: 'http://127.0.0.1:41234',
    })).toBe(false);

    // Per-agent allowedSkillIds excluding web-search hides web_search for that expert only.
    expect(h.isUnifiedWebSearchReady({
      llmProvider: 'lobsterai-server',
      skillsPolicy: openPolicy,
      allowedSkillIds: ['docx', 'xlsx'],
      bridgeUrl: 'http://127.0.0.1:41234',
    })).toBe(false);
    expect(h.isUnifiedWebSearchReady({
      llmProvider: 'lobsterai-server',
      skillsPolicy: openPolicy,
      allowedSkillIds: ['docx', 'web-search'],
      bridgeUrl: 'http://127.0.0.1:41234',
    })).toBe(true);
  });

  test('filters blocked hostnames, invalid schemes, and duplicate URLs from search sources', async () => {
    const h = await loadHelpers();

    const sources = h.filterSearchSourcesByPolicy(
      [
        { url: 'https://blocked.example.com/secret', title: 'Blocked', snippet: 'nope' },
        { url: 'https://docs.example.org/guide', title: 'Guide', snippet: 'Helpful snippet' },
        { url: 'https://docs.example.org/guide', title: 'Duplicate' },
        { url: 'file:///etc/passwd', title: 'Local file' },
        { url: 'https://sub.internal.corp/page', title: 'Corp' },
      ],
      ['blocked.example.com', '*.internal.corp'],
    );

    expect(sources).toEqual([
      { url: 'https://docs.example.org/guide', title: 'Guide', snippet: 'Helpful snippet' },
    ]);
  });

  test('identifies abort errors and non-transient DeepSeek native search cooldown errors', async () => {
    const h = await loadHelpers();

    const ac = new AbortController();
    expect(h.isSearchAbortError(Object.assign(new Error('aborted'), { code: 'WEB_ABORTED' }), ac.signal)).toBe(true);
    expect(h.isSearchAbortError(new Error('HTTP 500'), ac.signal)).toBe(false);
    ac.abort();
    expect(h.isSearchAbortError(new Error('anything'), ac.signal)).toBe(true);

    expect(h.shouldCooldownDeepSeekNativeError(new Error('DeepSeek API error (HTTP 400): Model Not Exist'))).toBe(true);
    expect(h.shouldCooldownDeepSeekNativeError(new Error('DeepSeek returned no web_search_tool_result blocks'))).toBe(true);
    expect(h.shouldCooldownDeepSeekNativeError(new Error('DeepSeek API error (HTTP 502): Bad Gateway'))).toBe(false);
  });
});
