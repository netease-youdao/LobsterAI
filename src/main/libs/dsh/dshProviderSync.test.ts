import { describe, expect, test, vi } from 'vitest';

import {
  buildDshMcpServerSpecs,
  buildDshProvidersPayload,
  normalizeDshMcpServerName,
} from './dshProviderSync';

describe('buildDshProvidersPayload', () => {
  test('translates standard API-key providers and routes OAuth/Plan providers through local modelAuthProxy', () => {
    const payload = buildDshProvidersPayload({
      modelAuthProxyUrl: 'http://127.0.0.1:45555',
      modelAuthProxySecret: 'proxy-secret',
      virtualAliases: {
        'yd-fast': { provider: 'lobster', model: 'deepseek-chat' },
      },
      providers: {
        openai: {
          enabled: true,
          apiKey: 'sk-openai',
          apiFormat: 'openai',
          models: [{ id: 'gpt-5', name: 'GPT-5', supportsImage: true }],
        },
        lobster: {
          enabled: true,
          authType: 'lobster_plan',
          apiFormat: 'openai',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        },
        disabledOne: {
          enabled: false,
          apiKey: 'sk-unused',
          baseUrl: 'https://example.com/v1',
          models: [{ id: 'm1' }],
        },
      },
    });

    expect(payload.providers.map((p) => p.id)).toEqual(['openai', 'lobster']);
    const openai = payload.providers.find((p) => p.id === 'openai')!;
    expect(openai.baseURL).toBe('https://api.openai.com/v1');
    expect(openai.models[0].input).toEqual(['text', 'image']);

    const lobster = payload.providers.find((p) => p.id === 'lobster')!;
    expect(lobster.baseURL).toBe('http://127.0.0.1:45555/v1/lobster');
    expect(lobster.apiKey).toBe('proxy-secret');
    expect(payload.virtualAliases['yd-fast']).toEqual({ provider: 'lobster', model: 'deepseek-chat' });
  });
});

describe('buildDshMcpServerSpecs', () => {
  test('normalizes server names, injects OAuth headers, and reports servers needing reauth', async () => {
    expect(normalizeDshMcpServerName('My Notion MCP!')).toBe('my-notion-mcp');

    const resolveAuthorizationHeaders = vi.fn(async (id: string) => {
      if (id === 'mcp-oauth-ok') return { Authorization: 'Bearer fresh-tok' };
      return null;
    });

    const result = await buildDshMcpServerSpecs(
      [
        {
          id: 'mcp-local',
          name: 'Local Files',
          enabled: true,
          transportType: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
        },
        {
          id: 'mcp-oauth-ok',
          name: 'Linear Remote',
          enabled: true,
          transportType: 'streamable-http',
          url: 'https://mcp.linear.app/mcp',
          oauthEnabled: true,
        },
        {
          id: 'mcp-oauth-expired',
          name: 'Jira Remote',
          enabled: true,
          transportType: 'streamable-http',
          url: 'https://mcp.atlassian.com/mcp',
          oauthEnabled: true,
        },
      ],
      { resolveAuthorizationHeaders },
    );

    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]).toMatchObject({ name: 'local-files', transport: 'stdio' });
    expect(result.servers[1]).toMatchObject({
      name: 'linear-remote',
      transport: 'streamable-http',
      headers: { Authorization: 'Bearer fresh-tok' },
    });
    expect(result.needsReauthIds).toEqual(['mcp-oauth-expired']);
  });
});
