import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCopilotLoopbackBaseUrl: vi.fn<() => string | null>(() => null),
  getCopilotLoopbackAuthToken: vi.fn<() => string | null>(() => null),
  readOpenAICodexAuthFile: vi.fn<() => { accessToken: string; accountId?: string } | null>(() => null),
  readStoredXaiCredential: vi.fn<() => { access: string } | null>(() => null),
}));

vi.mock('./copilotLoopbackProxy', () => ({
  getCopilotLoopbackBaseUrl: mocks.getCopilotLoopbackBaseUrl,
  getCopilotLoopbackAuthToken: mocks.getCopilotLoopbackAuthToken,
}));

vi.mock('./openaiCodexAuth', () => ({
  readOpenAICodexAuthFile: mocks.readOpenAICodexAuthFile,
}));

vi.mock('./openclawXaiAuthStore', () => ({
  readStoredXaiCredential: mocks.readStoredXaiCredential,
}));

vi.mock('./openclawTokenProxy', () => ({
  consumeRecentOpenClawTokenProxyQuotaError: vi.fn(),
  getOpenClawTokenProxyPort: vi.fn(),
  getOpenClawTokenProxyTraceStats: vi.fn(),
  startOpenClawTokenProxy: vi.fn(),
  stopOpenClawTokenProxy: vi.fn(),
}));

import { resolveDefaultOAuthProviderUpstream } from './modelAuthProxy';

describe('resolveDefaultOAuthProviderUpstream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCopilotLoopbackBaseUrl.mockReturnValue(null);
    mocks.getCopilotLoopbackAuthToken.mockReturnValue(null);
    mocks.readOpenAICodexAuthFile.mockReturnValue(null);
    mocks.readStoredXaiCredential.mockReturnValue(null);
  });

  test('resolves GitHub Copilot upstream for both github-copilot and lobsterai-copilot', () => {
    mocks.getCopilotLoopbackBaseUrl.mockReturnValue('http://127.0.0.1:41234/v1');
    mocks.getCopilotLoopbackAuthToken.mockReturnValue('copilot-loopback-secret');

    expect(resolveDefaultOAuthProviderUpstream('github-copilot')).toEqual({
      baseUrl: 'http://127.0.0.1:41234/v1',
      headers: { authorization: 'Bearer copilot-loopback-secret' },
    });
    expect(resolveDefaultOAuthProviderUpstream('lobsterai-copilot')).toEqual({
      baseUrl: 'http://127.0.0.1:41234/v1',
      headers: { authorization: 'Bearer copilot-loopback-secret' },
    });
  });

  test('resolves OpenAI Codex OAuth upstream with account header', () => {
    mocks.readOpenAICodexAuthFile.mockReturnValue({
      accessToken: 'codex-jwt-token',
      accountId: 'acct-123',
    });

    expect(resolveDefaultOAuthProviderUpstream('openai-codex')).toEqual({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      headers: {
        authorization: 'Bearer codex-jwt-token',
        'chatgpt-account-id': 'acct-123',
      },
    });
  });

  test('resolves xAI OAuth upstream with bearer token', () => {
    mocks.readStoredXaiCredential.mockReturnValue({ access: 'xai-access-token' });

    expect(resolveDefaultOAuthProviderUpstream('xai-oauth')).toEqual({
      baseUrl: 'https://api.x.ai/v1',
      headers: { authorization: 'Bearer xai-access-token' },
    });
  });

  test('returns null for unknown providers or missing credentials', () => {
    expect(resolveDefaultOAuthProviderUpstream('minimax')).toBeNull();
    expect(resolveDefaultOAuthProviderUpstream('xai-oauth')).toBeNull();
    expect(resolveDefaultOAuthProviderUpstream('openai-codex')).toBeNull();
  });
});
