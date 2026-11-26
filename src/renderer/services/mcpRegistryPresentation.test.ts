import { describe, expect, test } from 'vitest';

import { selectMarketplaceRegistry } from '../data/mcpRegistry';
import type { McpRegistryEntry, McpServerConfig } from '../types/mcp';
import { McpRegistryEntryKind } from '../types/mcp';
import {
  buildInstalledMcpItems,
  getRegistryEntryDisplayName,
  getRegistryEntryLocalizedDescription,
} from './mcpRegistryPresentation';

function registryEntry(id: string, overrides: Partial<McpRegistryEntry> = {}): McpRegistryEntry {
  return {
    id,
    name: id,
    descriptionKey: '',
    category: 'developer',
    categoryKey: '',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: [],
    ...overrides,
  };
}

function server(id: string, registryId?: string): McpServerConfig {
  return {
    id,
    name: id,
    description: '',
    enabled: true,
    transportType: 'http',
    url: `https://example.com/${id}`,
    isBuiltIn: Boolean(registryId),
    registryId,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('curated connector marketplace', () => {
  test('uses the seven bundled providers for a legacy catalog', () => {
    expect(selectMarketplaceRegistry().map(entry => entry.id)).toEqual([
      'tdx', 'connector-wecom', 'connector-feishu', 'connector-dingtalk', 'connector-github', 'notion-oauth', 'baidu-drive',
    ]);
    expect(selectMarketplaceRegistry([])).toEqual([]);
  });

  test('keeps only supported providers in published order and uses their bundled icons', () => {
    const feishu = { id: 'connector-feishu', name: 'Feishu', category: 'productivity', transportType: 'skill', icon: 'old.png' };
    const github = { ...feishu, id: 'connector-github', name: 'GitHub' };
    const retired = { ...feishu, id: 'tavily', transportType: 'stdio' };
    const result = selectMarketplaceRegistry([github, retired, feishu, github]);
    expect(result[0]).toMatchObject({
      transportType: 'http', connector: { auth: 'oauth', url: 'https://api.githubcopilot.com/mcp/' },
    });
    expect(result.map(entry => [entry.id, entry.icon])).toEqual([
      ['connector-github', 'connector-icons/connector-github.png'],
      ['connector-feishu', 'connector-icons/connector-feishu.png'],
    ]);
  });
});

describe('buildInstalledMcpItems', () => {
  test('groups servers for registry entries declared as bundles', () => {
    const bundle = registryEntry('bundle', { kind: McpRegistryEntryKind.Bundle });
    const items = buildInstalledMcpItems([server('one', 'bundle')], [bundle]);

    expect(items).toEqual([expect.objectContaining({
      kind: 'registryGroup',
      registryId: 'bundle',
      servers: [expect.objectContaining({ id: 'one' })],
    })]);
  });

  test('infers a group from multiple historical records with the same registry id', () => {
    const items = buildInstalledMcpItems([
      server('first'),
      server('bundle-one', 'bundle'),
      server('bundle-two', 'bundle'),
      server('last'),
    ], []);

    expect(items.map(item => item.id)).toEqual(['first', 'bundle', 'last']);
    expect(items[1]).toEqual(expect.objectContaining({
      kind: 'registryGroup',
      servers: [
        expect.objectContaining({ id: 'bundle-one' }),
        expect.objectContaining({ id: 'bundle-two' }),
      ],
    }));
  });

  test('keeps an ordinary single registry server as an individual item', () => {
    const single = registryEntry('single');
    const items = buildInstalledMcpItems([server('one', 'single')], [single]);

    expect(items).toEqual([expect.objectContaining({ kind: 'server', id: 'one' })]);
  });
});


describe('localized registry text', () => {
  test('uses the Chinese name in zh and the plain name in en', () => {
    const entry = registryEntry('amap', { name: 'Amap Maps', name_zh: '高德地图' });
    expect(getRegistryEntryDisplayName(entry, 'zh')).toBe('高德地图');
    expect(getRegistryEntryDisplayName(entry, 'en')).toBe('Amap Maps');
  });

  test('falls back to the plain name when no Chinese name is published', () => {
    const legacy = registryEntry('amap', { name: 'Amap Maps' });
    expect(getRegistryEntryDisplayName(legacy, 'zh')).toBe('Amap Maps');
  });

  test('ignores a blank Chinese name', () => {
    const entry = registryEntry('amap', { name: 'Amap Maps', name_zh: '   ' });
    expect(getRegistryEntryDisplayName(entry, 'zh')).toBe('Amap Maps');
  });

  test('resolves descriptions from the per-language pair', () => {
    const entry = registryEntry('amap', { description_zh: '地图服务', description_en: 'Maps' });
    expect(getRegistryEntryLocalizedDescription(entry, 'zh')).toBe('地图服务');
    expect(getRegistryEntryLocalizedDescription(entry, 'en')).toBe('Maps');
    expect(getRegistryEntryLocalizedDescription(registryEntry('x'), 'zh')).toBe('');
  });

  test('falls back to the other language when one description is missing', () => {
    const zhOnly = registryEntry('amap', { description_zh: '地图服务' });
    expect(getRegistryEntryLocalizedDescription(zhOnly, 'en')).toBe('地图服务');
  });
});
