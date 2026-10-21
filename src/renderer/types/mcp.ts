import type { McpAuthMode } from '../../shared/mcp/auth';
import type { McpMarketplaceConnector } from '../../shared/mcp/marketplace';

// MCP Server type definitions
export type McpTransportType = 'stdio' | 'sse' | 'http';

// Per-server MCP tool selection, forwarded to OpenClaw's mcp.servers.*.toolFilter.
// Excluded tools never reach the model payload (~350 prompt tokens saved per tool).
export interface McpToolFilter {
  include?: string[];
  exclude?: string[];
}

export const McpRegistryEntryKind = {
  Server: 'server',
  Bundle: 'bundle',
} as const;
export type McpRegistryEntryKind = typeof McpRegistryEntryKind[keyof typeof McpRegistryEntryKind];

export interface McpServerConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transportType: McpTransportType;
  command?: string;              // stdio
  args?: string[];               // stdio
  env?: Record<string, string>;  // stdio
  url?: string;                  // sse / http
  headers?: Record<string, string>; // sse / http
  auth?: McpAuthMode;            // sse / http: 'oauth' = sign in via MCP OAuth (OpenClaw stores the token)
  tokenValues?: Record<string, string>; // marketplace connector credential form values (re-shown on edit)
  toolFilter?: McpToolFilter;    // expose only / hide selected tools
  supportsParallelToolCalls?: boolean; // allow parallel execution of this server's tools
  requestTimeoutMs?: number;     // per-request timeout passed to OpenClaw
  connectionTimeoutMs?: number;  // connect timeout passed to OpenClaw
  isBuiltIn: boolean;            // installed from built-in registry
  githubUrl?: string;            // GitHub repository URL
  registryId?: string;           // matching registry entry ID
  launchResolution?: McpLaunchResolution;
  createdAt: number;
  updatedAt: number;
}

export interface McpLaunchResolution {
  serverId: string;
  resolverKind: 'npx' | 'uvx' | 'python' | 'raw';
  sourceFingerprint: string;
  status: 'pending' | 'installing' | 'ready' | 'failed' | 'unsupported';
  packageName?: string;
  requestedVersion?: string;
  resolvedVersion?: string;
  installDir?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  error?: string;
  installedAt?: number;
  resolvedAt?: number;
  lastProbeAt?: number;
  lastProbeStatus?: string;
  updatedAt: number;
}

export interface McpServerFormData {
  name: string;
  description: string;
  transportType: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: McpAuthMode;
  tokenValues?: Record<string, string>;
  toolFilter?: McpToolFilter;
  supportsParallelToolCalls?: boolean;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  isBuiltIn?: boolean;
  githubUrl?: string;
  registryId?: string;
}

// Built-in MCP registry entry (pure frontend definition)
export interface McpRegistryEntry {
  id: string;                    // unique identifier, e.g. 'filesystem'
  name: string;                  // display name, English; also the zh fallback
  name_zh?: string;              // Chinese display name (remote data)
  icon?: string;                 // icon URL (remote data); falls back to the default glyph
  descriptionKey: string;        // i18n translation key for description
  description_zh?: string;       // Chinese description (remote data)
  description_en?: string;       // English description (remote data)
  category: McpCategory;         // category tag
  categoryKey: string;           // i18n translation key for category
  transportType: McpTransportType;
  command: string;               // default command, e.g. 'npx'; empty for remote entries
  defaultArgs: string[];         // default arguments
  requiredEnvKeys?: string[];    // env vars the user must fill
  optionalEnvKeys?: string[];    // optional env vars
  argPlaceholders?: string[];    // placeholder hints for args (e.g. path)
  oauthProvider?: 'qichacha';    // special app-managed OAuth/API key flow
  kind?: McpRegistryEntryKind;   // defaults to a single-server registry entry
  marketplacePosition?: number;  // 1-based preferred position; clamps to the available list
  connector?: McpMarketplaceConnector; // remote URL/auth/credential form, tool allowlist, examples
}

// Remote marketplace server entry. Connector fields are untrusted remote JSON;
// `parseMcpMarketplaceConnector` validates them (see McpMarketplaceConnector).
export interface McpMarketplaceServer {
  id: string;
  name: string;
  name_zh?: string;
  icon?: string;
  description_zh?: string;
  description_en?: string;
  category: string;
  transportType: string;
  command?: string;              // stdio only
  defaultArgs?: string[];        // stdio only
  requiredEnvKeys?: string[];
  optionalEnvKeys?: string[];
  kind?: McpRegistryEntryKind;
  url?: unknown;
  auth?: unknown;
  tokenSchema?: unknown;
  tokenAuth?: unknown;
  allowedTools?: unknown;
  requestTimeoutMs?: unknown;
  connectionTimeoutMs?: unknown;
  examples_zh?: unknown;
  examples_en?: unknown;
}

// Dynamic marketplace category from remote
export interface McpMarketplaceCategoryInfo {
  id: string;
  name_zh: string;
  name_en: string;
}

export type McpCategory =
  | 'search'
  | 'browser'
  | 'developer'
  | 'productivity'
  | 'design'
  | 'data-api';
