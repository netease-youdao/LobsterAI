// MCP Server type definitions
export type McpTransportType = 'stdio' | 'sse' | 'http';

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
  isBuiltIn: boolean;            // installed from built-in registry
  githubUrl?: string;            // GitHub repository URL
  registryId?: string;           // matching registry entry ID
  createdAt: number;
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
  isBuiltIn?: boolean;
  githubUrl?: string;
  registryId?: string;
}

// Built-in MCP registry entry (pure frontend definition)
export interface McpRegistryEntry {
  id: string;                    // unique identifier, e.g. 'filesystem'
  name: string;                  // display name
  descriptionKey: string;        // i18n translation key for description
  category: McpCategory;         // category tag
  categoryKey: string;           // i18n translation key for category
  githubUrl: string;             // GitHub repository URL
  transportType: McpTransportType;
  command: string;               // default command, e.g. 'npx'
  defaultArgs: string[];         // default arguments
  requiredEnvKeys?: string[];    // env vars the user must fill
  optionalEnvKeys?: string[];    // optional env vars
  argPlaceholders?: string[];    // placeholder hints for args (e.g. path)
}

export type McpCategory =
  | 'filesystem'
  | 'search'
  | 'browser'
  | 'database'
  | 'developer'
  | 'productivity'
  | 'data-api'
  | 'memory'
  | 'reasoning'
  | 'cloud';
