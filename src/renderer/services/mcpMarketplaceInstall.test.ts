import { describe, expect, test, vi } from 'vitest';

import { McpAuthMode } from '../../shared/mcp/auth';
import { McpConnectorBuildError, McpTokenValueError } from '../../shared/mcp/marketplace';
import type { McpMarketplaceServer, McpRegistryEntry } from '../types/mcp';
import {
  buildOAuthRegistryInstallData,
  buildRegistryRemoteServerData,
  convertMarketplaceToRegistry,
  getRegistryInstallDefaults,
  isOAuthRegistryEntry,
  isRemoteRegistryEntry,
} from './mcpMarketplaceInstall';
import {
  getRegistryEntryEndpointSummary,
  getRegistryEntryExamples,
  getRegistryEntryRequiredKeyCount,
} from './mcpRegistryPresentation';

// The three connectors used to verify remote installs end to end.
const tencentDocs: McpMarketplaceServer = {
  id: 'tencent-docs',
  name: 'Tencent Docs',
  name_zh: '腾讯文档',
  category: 'productivity',
  transportType: 'http',
  url: 'https://docs.qq.com/openapi/mcp',
  tokenSchema: {
    title: '腾讯文档授权',
    title_en: 'Tencent Docs access',
    docUrl: 'https://docs.qq.com/open/auth/mcp.html',
    fields: [{ key: 'TENCENT_DOCS_TOKEN', label: '访问令牌', label_en: 'Access token', type: 'password', required: true }],
  },
  tokenAuth: { headers: { Authorization: { field: 'TENCENT_DOCS_TOKEN' } } },
  examples_zh: ['把这周的会议纪要整理成一篇腾讯文档'],
  examples_en: ['Turn this week\'s meeting notes into a Tencent Docs document'],
};

const baiduMaps: McpMarketplaceServer = {
  id: 'baidu-maps',
  name: 'Baidu Maps',
  name_zh: '百度地图',
  category: 'data-api',
  transportType: 'http',
  url: 'https://mcp.map.baidu.com/mcp?ak=${BAIDU_MAP_AK}',
  tokenSchema: {
    fields: [{ key: 'BAIDU_MAP_AK', label: '服务端 AK', label_en: 'Server AK', type: 'password', required: true }],
  },
  requestTimeoutMs: 60000,
};

const notion: McpMarketplaceServer = {
  id: 'notion',
  name: 'Notion',
  category: 'productivity',
  transportType: 'http',
  url: 'https://mcp.notion.com/mcp',
  auth: 'oauth',
  allowedTools: ['notion-search', 'notion-fetch'],
  examples_en: ['Find my notes about the launch plan'],
};

const stdioEntry: McpMarketplaceServer = {
  id: 'tavily',
  name: 'Tavily',
  category: 'search',
  transportType: 'stdio',
  command: 'npx',
  defaultArgs: ['-y', 'tavily-mcp'],
  requiredEnvKeys: ['TAVILY_API_KEY'],
};

const convertOne = (server: McpMarketplaceServer): McpRegistryEntry => {
  const [entry] = convertMarketplaceToRegistry([server]);
  if (!entry) throw new Error(`${server.id} did not convert`);
  return entry;
};

describe('convertMarketplaceToRegistry', () => {
  test('keeps stdio entries as before', () => {
    expect(convertOne(stdioEntry)).toEqual({
      id: 'tavily',
      name: 'Tavily',
      name_zh: undefined,
      icon: undefined,
      descriptionKey: '',
      description_zh: undefined,
      description_en: undefined,
      category: 'search',
      categoryKey: '',
      transportType: 'stdio',
      command: 'npx',
      defaultArgs: ['-y', 'tavily-mcp'],
      requiredEnvKeys: ['TAVILY_API_KEY'],
      optionalEnvKeys: undefined,
      kind: undefined,
    });
  });

  test('converts remote connectors and drops entries that do not validate', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const entries = convertMarketplaceToRegistry([
      tencentDocs,
      baiduMaps,
      notion,
      { ...tencentDocs, id: 'broken', tokenAuth: { headers: { Host: { field: 'TENCENT_DOCS_TOKEN' } } } },
    ]);
    expect(entries.map(entry => entry.id)).toEqual(['tencent-docs', 'baidu-maps', 'notion']);
    expect(entries.every(isRemoteRegistryEntry)).toBe(true);
    expect(entries.map(isOAuthRegistryEntry)).toEqual([false, false, true]);
    expect(entries[0]).toMatchObject({ command: '', defaultArgs: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"broken"'));
    warn.mockRestore();
  });
});

describe('buildRegistryRemoteServerData', () => {
  test('Tencent Docs binds the token to Authorization', () => {
    expect(buildRegistryRemoteServerData(convertOne(tencentDocs), { TENCENT_DOCS_TOKEN: ' tok-123 ' })).toEqual({
      ok: true,
      data: {
        transportType: 'http',
        url: 'https://docs.qq.com/openapi/mcp',
        headers: { Authorization: 'tok-123' },
        auth: McpAuthMode.None,
        tokenValues: { TENCENT_DOCS_TOKEN: 'tok-123' },
      },
    });
  });

  test('Baidu Maps fills the URL template', () => {
    expect(buildRegistryRemoteServerData(convertOne(baiduMaps), { BAIDU_MAP_AK: 'ak/+=1' })).toEqual({
      ok: true,
      data: {
        transportType: 'http',
        url: 'https://mcp.map.baidu.com/mcp?ak=ak%2F%2B%3D1',
        headers: {},
        auth: McpAuthMode.None,
        tokenValues: { BAIDU_MAP_AK: 'ak/+=1' },
      },
    });
  });

  test('reports the empty required field', () => {
    expect(buildRegistryRemoteServerData(convertOne(baiduMaps), {})).toEqual({
      ok: false,
      code: McpConnectorBuildError.InvalidFields,
      fieldErrors: { BAIDU_MAP_AK: McpTokenValueError.Required },
    });
  });

  test('Notion carries no credentials and asks for OAuth', () => {
    expect(buildRegistryRemoteServerData(convertOne(notion), { ignored: 'x' })).toEqual({
      ok: true,
      data: {
        transportType: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: {},
        auth: McpAuthMode.OAuth,
      },
    });
  });
});

describe('install defaults and one-click OAuth installs', () => {
  test('maps allowedTools to toolFilter.include and passes timeouts', () => {
    expect(getRegistryInstallDefaults(convertOne(notion))).toEqual({
      toolFilter: { include: ['notion-search', 'notion-fetch'] },
    });
    expect(getRegistryInstallDefaults(convertOne(baiduMaps))).toEqual({ requestTimeoutMs: 60000 });
    expect(getRegistryInstallDefaults(convertOne(stdioEntry))).toEqual({});
  });

  test('builds the full create payload for an OAuth connector', () => {
    expect(buildOAuthRegistryInstallData(convertOne(notion), { name: 'Notion', description: 'Notes' })).toEqual({
      ok: true,
      data: {
        name: 'Notion',
        description: 'Notes',
        transportType: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: {},
        auth: McpAuthMode.OAuth,
        toolFilter: { include: ['notion-search', 'notion-fetch'] },
        isBuiltIn: true,
        registryId: 'notion',
      },
    });
  });
});

describe('connector presentation', () => {
  test('summarizes the endpoint without exposing template placeholders', () => {
    expect(getRegistryEntryEndpointSummary(convertOne(tencentDocs))).toBe('docs.qq.com');
    expect(getRegistryEntryEndpointSummary(convertOne(baiduMaps))).toBe('mcp.map.baidu.com');
    expect(getRegistryEntryEndpointSummary(convertOne(stdioEntry))).toBe('npx tavily-mcp');
  });

  test('counts required credentials across env keys and connector fields', () => {
    expect(getRegistryEntryRequiredKeyCount(convertOne(tencentDocs))).toBe(1);
    expect(getRegistryEntryRequiredKeyCount(convertOne(notion))).toBe(0);
    expect(getRegistryEntryRequiredKeyCount(convertOne(stdioEntry))).toBe(1);
  });

  test('picks examples in the UI language, falling back to the other', () => {
    expect(getRegistryEntryExamples(convertOne(tencentDocs), 'zh')).toEqual(['把这周的会议纪要整理成一篇腾讯文档']);
    expect(getRegistryEntryExamples(convertOne(notion), 'zh')).toEqual(['Find my notes about the launch plan']);
    expect(getRegistryEntryExamples(convertOne(stdioEntry), 'en')).toEqual([]);
  });
});
