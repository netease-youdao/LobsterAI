import { convertMarketplaceToRegistry } from '../services/mcpMarketplaceInstall';
import { type McpMarketplaceServer, type McpRegistryEntry, McpRegistryEntryKind } from '../types/mcp';
import catalog from './mcpRegistry.json';

const bundledRegistry = convertMarketplaceToRegistry(catalog.servers);
const bundledById = new Map(bundledRegistry.map(entry => [entry.id, entry]));

/** Older Overmind payloads lack featuredConnectors. A published empty list explicitly clears the market. */
export function selectMarketplaceRegistry(featured?: McpMarketplaceServer[]): McpRegistryEntry[] {
  if (!Array.isArray(featured)) return bundledRegistry;
  const selected: McpRegistryEntry[] = [];
  const seen = new Set<string>();
  // Upgrade the GitHub CLI entry in previously cached catalogs at its published position.
  const github = catalog.servers.find(server => server.id === 'connector-github');
  const current = featured.map(server => github && server.id === github.id && server.transportType === 'skill'
    ? github : server);
  for (const entry of convertMarketplaceToRegistry(current)) {
    const bundled = bundledById.get(entry.id);
    if (!bundled || seen.has(entry.id) || entry.transportType !== bundled.transportType
      || entry.connector?.auth !== bundled.connector?.auth) continue;
    seen.add(entry.id);
    selected.push({ ...entry, icon: bundled.icon });
  }
  return selected;
}

/** Metadata used to manage existing bundle installations. */
export const legacyInstalledRegistry: McpRegistryEntry[] = [
  {
    id: 'qichacha',
    name: '企查查',
    descriptionKey: 'mcpDesc_qichacha',
    category: 'data-api',
    categoryKey: 'mcpCategoryDataApi',
    transportType: 'http',
    command: 'https://agent.qcc.com/mcp',
    defaultArgs: ['6 servers'],
    oauthProvider: 'qichacha',
    kind: McpRegistryEntryKind.Bundle,
  },
];

/**
 * Category fallbacks with their i18n keys, used until the server list (which
 * carries its own localized names) has loaded.
 */
export const mcpCategories = [
  { id: 'all', key: 'mcpCategoryAll' },
  { id: 'search', key: 'mcpCategorySearch' },
  { id: 'developer', key: 'mcpCategoryDeveloper' },
  { id: 'productivity', key: 'mcpCategoryProductivity' },
  { id: 'browser', key: 'mcpCategoryBrowser' },
  { id: 'design', key: 'mcpCategoryDesign' },
  { id: 'data-api', key: 'mcpCategoryDataApi' },
] as const;
