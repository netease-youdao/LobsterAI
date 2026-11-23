import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test } from 'vitest';

const HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/web-access-guard-helpers.mjs'),
).href;

type WebAccessGuardHelpers = {
  DSH_SEARCH_POLICY: {
    DeepSeekNativeOnly: string;
    LobsterWebSearchOnly: string;
    AllowAll: string;
  };
  normalizeHostnamePolicyList: (entries: unknown) => string[];
  evaluateWebAccessGuard: (
    toolName: unknown,
    args: unknown,
    policy: { webFetchEnabled?: boolean; webSearchEnabled?: boolean; blockedHostnames?: readonly string[]; searchPolicy?: string },
    context?: { llmProvider?: string },
  ) => string | undefined;
};

let cached: WebAccessGuardHelpers | null = null;
async function loadHelpers(): Promise<WebAccessGuardHelpers> {
  if (!cached) {
    cached = (await import(HELPERS_URL)) as WebAccessGuardHelpers;
  }
  return cached;
}

describe('web-access-guard-helpers', () => {
  test('blocks web_fetch whenever webFetchEnabled is false', async () => {
    const { evaluateWebAccessGuard } = await loadHelpers();

    expect(
      evaluateWebAccessGuard('web_fetch', { url: 'https://docs.example.org/guide' }, { webFetchEnabled: false }),
    ).toContain('disabled');
  });

  test('blocks web_fetch against exact, wildcard, www-normalized apex, and non-http URLs', async () => {
    const { evaluateWebAccessGuard, normalizeHostnamePolicyList } = await loadHelpers();

    const blockedHostnames = normalizeHostnamePolicyList([
      'https://blocked.example.com:8443/path',
      'https://www.apex-blocked.com',
      '*.internal.corp',
    ]);
    expect(blockedHostnames).toEqual(['blocked.example.com', 'www.apex-blocked.com', '*.internal.corp']);

    const policy = { webFetchEnabled: true, blockedHostnames };

    expect(evaluateWebAccessGuard('web_fetch', { url: 'https://blocked.example.com/secret' }, policy)).toContain(
      'blocked.example.com',
    );
    expect(evaluateWebAccessGuard('web_fetch', { url: 'https://apex-blocked.com/page' }, policy)).toContain(
      'apex-blocked.com',
    );
    expect(evaluateWebAccessGuard('web_fetch', { url: 'https://wiki.internal.corp/docs' }, policy)).toContain(
      '*.internal.corp',
    );
    expect(evaluateWebAccessGuard('web_fetch', { url: 'file:///etc/passwd' }, policy)).toContain('scheme');

    // Allowed URLs pass through cleanly.
    expect(evaluateWebAccessGuard('web_fetch', { url: 'https://allowed.example.org/docs' }, policy)).toBeUndefined();
    expect(evaluateWebAccessGuard('web_fetch', { url: 'https://internal.corp/public' }, policy)).toBeUndefined();
  });

  test('enforces DshSearchPolicy on built-in DSH web_search without interfering with MCP tools', async () => {
    const { DSH_SEARCH_POLICY, evaluateWebAccessGuard } = await loadHelpers();

    expect(
      evaluateWebAccessGuard(
        'web_search',
        { queries: ['news'] },
        { searchPolicy: DSH_SEARCH_POLICY.DeepSeekNativeOnly },
        { llmProvider: 'openai' },
      ),
    ).toContain('DeepSeek');

    expect(
      evaluateWebAccessGuard(
        'web_search',
        { queries: ['news'] },
        { searchPolicy: DSH_SEARCH_POLICY.DeepSeekNativeOnly },
        { llmProvider: 'deepseek-official' },
      ),
    ).toBeUndefined();

    expect(
      evaluateWebAccessGuard(
        'web_search',
        { queries: ['news'] },
        { searchPolicy: DSH_SEARCH_POLICY.LobsterWebSearchOnly },
        { llmProvider: 'deepseek-official' },
      ),
    ).toContain('disabled');

    expect(
      evaluateWebAccessGuard(
        'web_search',
        { queries: ['news'] },
        { searchPolicy: DSH_SEARCH_POLICY.AllowAll },
        { llmProvider: 'openai' },
      ),
    ).toBeUndefined();

    // Disabling web-search skill blocks web_search synchronously even under AllowAll.
    expect(
      evaluateWebAccessGuard(
        'web_search',
        { queries: ['news'] },
        { webSearchEnabled: false, searchPolicy: DSH_SEARCH_POLICY.AllowAll },
        { llmProvider: 'deepseek' },
      ),
    ).toContain('disabled');

    expect(
      evaluateWebAccessGuard(
        'mcp__tavily__tavily_search',
        { query: 'news' },
        { webFetchEnabled: false, blockedHostnames: ['example.com'], searchPolicy: DSH_SEARCH_POLICY.LobsterWebSearchOnly },
      ),
    ).toBeUndefined();
  });
});
