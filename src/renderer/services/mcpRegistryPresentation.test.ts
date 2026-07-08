import { describe, expect, test } from 'vitest';

import type { McpRegistryEntry, McpServerConfig } from '../types/mcp';
import { McpRegistryEntryKind } from '../types/mcp';
import { buildInstalledMcpItems, mergeMarketplaceRegistry } from './mcpRegistryPresentation';

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

describe('mergeMarketplaceRegistry', () => {
  const qichacha = registryEntry('qichacha', {
    oauthProvider: 'qichacha',
    kind: McpRegistryEntryKind.Bundle,
    marketplacePosition: 4,
  });

  test('inserts a managed local entry at its 1-based preferred position', () => {
    const remote = ['one', 'two', 'three', 'four', 'five'].map(id => registryEntry(id));

    expect(mergeMarketplaceRegistry(remote, [qichacha]).map(entry => entry.id)).toEqual([
      'one',
      'two',
      'three',
      'qichacha',
      'four',
      'five',
    ]);
  });

  test('appends when the preferred position exceeds the remote list', () => {
    const remote = ['one', 'two'].map(id => registryEntry(id));

    expect(mergeMarketplaceRegistry(remote, [qichacha]).map(entry => entry.id)).toEqual([
      'one',
      'two',
      'qichacha',
    ]);
  });

  test('uses the managed local definition when the remote list has the same id', () => {
    const remote = [registryEntry('one'), registryEntry('qichacha'), registryEntry('two')];
    const result = mergeMarketplaceRegistry(remote, [qichacha]);

    expect(result.filter(entry => entry.id === 'qichacha')).toEqual([qichacha]);
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
