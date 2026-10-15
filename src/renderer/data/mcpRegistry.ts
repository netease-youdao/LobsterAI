import { McpAuthMode } from '../../shared/mcp/auth';
import lynxceOmniIconUrl from '../assets/mcp/lynxce-omni.svg';
import { McpRegistryEntry, McpRegistryEntryKind } from '../types/mcp';

/**
 * App-managed MCP registry entries.
 *
 * Marketplace content comes from the server (`mcpService.fetchMarketplace`,
 * cached in localStorage between sessions) — it is deliberately NOT mirrored
 * here, so there is a single source of truth for names, descriptions and the
 * server list itself. This file only holds entries the server payload cannot
 * express: flows managed by the app, such as the Qichacha OAuth bundle and
 * remote servers that sign in with MCP OAuth, which `mergeMarketplaceRegistry`
 * re-inserts into whatever the server returns.
 */
export const mcpRegistry: McpRegistryEntry[] = [
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
    marketplacePosition: 4,
  },
  {
    id: 'lynxce-omni',
    name: 'Lynxce Omni AI',
    name_zh: '灵策全能AI',
    icon: lynxceOmniIconUrl,
    descriptionKey: 'mcpDesc_lynxceOmni',
    category: 'design',
    categoryKey: 'mcpCategoryDesign',
    transportType: 'http',
    command: 'https://web.lynxce.cn/api/mcp',
    defaultArgs: [],
    auth: McpAuthMode.OAuth,
    skillId: 'lynxce-omni',
    marketplacePosition: 5,
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
