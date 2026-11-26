// Offline extractor & migrator for legacy OpenClaw plugin/search Tavily configs
// into LobsterAI's SQLite `mcp_servers` table (`npx -y tavily-mcp@latest`).
//
// Zero Electron imports — directly testable under Node Vitest.

import type Database from 'better-sqlite3';
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const LegacyTavilySource = {
  UserPlugins: 'user_plugins',
  OpenClawUserJson: 'openclaw.user.json',
  OpenClawJson: 'openclaw.json',
} as const;
export type LegacyTavilySource = typeof LegacyTavilySource[keyof typeof LegacyTavilySource];

export const TAVILY_MCP_REGISTRY_ID = 'tavily';
export const TAVILY_MCP_DEFAULT_NAME = 'Tavily';
export const TAVILY_MCP_DEFAULT_DESCRIPTION =
  'Real-time web search, intelligent data extraction and web crawling';
export const TAVILY_MCP_DEFAULT_COMMAND = 'npx';
export const TAVILY_MCP_DEFAULT_ARGS = ['-y', 'tavily-mcp@latest'] as const;
export const TAVILY_API_KEY_ENV = 'TAVILY_API_KEY';

export interface LegacyUserPluginRow {
  plugin_id?: string | null;
  pluginId?: string | null;
  spec?: string | null;
  enabled?: number | boolean | null;
  config?: string | Record<string, unknown> | null;
}

export interface LegacyTavilyExtractionInput {
  userPlugins?: LegacyUserPluginRow[];
  openclawUserConfig?: Record<string, unknown> | null;
  openclawConfig?: Record<string, unknown> | null;
}

export interface ExtractedLegacyTavilyConfig {
  apiKey: string;
  enabled: boolean;
  source: LegacyTavilySource;
}

export interface MigrateLegacyTavilyResult {
  migrated: boolean;
  serverId?: string;
  enabled?: boolean;
  source?: LegacyTavilySource;
  skippedReason?: 'already_exists' | 'not_found';
}

const TAVILY_NAME_RE = /tavily/i;
const ENV_PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const API_KEY_FIELD_NAMES = [
  'apiKey',
  'tavilyApiKey',
  'tavily_api_key',
  'api_key',
  'TAVILY_API_KEY',
  'key',
  'token',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeParseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return asRecord(raw);
}

function safeReadJsonObject(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return asRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

function collectEnvMap(...configs: Array<Record<string, unknown> | null | undefined>): Record<string, string> {
  const envMap: Record<string, string> = {};
  for (const cfg of configs) {
    if (!cfg) continue;
    const envBlock = asRecord(cfg.env);
    if (!envBlock) continue;
    for (const [key, val] of Object.entries(envBlock)) {
      if (typeof val === 'string' && val.trim().length > 0) {
        envMap[key] = val.trim();
      }
    }
    const varsBlock = asRecord(envBlock.vars);
    if (varsBlock) {
      for (const [key, val] of Object.entries(varsBlock)) {
        if (typeof val === 'string' && val.trim().length > 0) {
          envMap[key] = val.trim();
        }
      }
    }
  }
  return envMap;
}

function resolveKeyString(raw: unknown, envMap: Record<string, string>): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const placeholder = ENV_PLACEHOLDER_RE.exec(trimmed);
  if (placeholder) {
    const resolved = envMap[placeholder[1]];
    return resolved && !ENV_PLACEHOLDER_RE.test(resolved) ? resolved : null;
  }
  return trimmed;
}

function extractApiKeyFromTavilyRecord(
  record: Record<string, unknown> | null,
  envMap: Record<string, string>,
  depth = 0,
): string | null {
  if (!record || depth > 3) return null;

  for (const field of API_KEY_FIELD_NAMES) {
    const candidate = resolveKeyString(record[field], envMap);
    if (candidate) return candidate;
  }

  for (const nestedKey of ['config', 'env', 'webSearch', 'search', 'tavily', 'settings', 'credentials']) {
    const nested = asRecord(record[nestedKey]);
    if (nested) {
      const candidate = extractApiKeyFromTavilyRecord(nested, envMap, depth + 1);
      if (candidate) return candidate;
    }
  }
  return null;
}

function resolveUserPluginEnabled(row: LegacyUserPluginRow, parsedConfig: Record<string, unknown> | null): boolean {
  if (row.enabled === 0 || row.enabled === false) return false;
  if (parsedConfig && parsedConfig.enabled === false) return false;
  return true;
}

function extractFromUserPlugins(
  rows: LegacyUserPluginRow[],
  envMap: Record<string, string>,
): { config: ExtractedLegacyTavilyConfig | null; explicitDisabled: boolean } {
  let fallbackCandidate: ExtractedLegacyTavilyConfig | null = null;
  let explicitDisabled = false;

  for (const row of rows) {
    const pluginId = String(row.plugin_id ?? row.pluginId ?? '').trim();
    const spec = String(row.spec ?? '').trim();
    if (!TAVILY_NAME_RE.test(pluginId) && !TAVILY_NAME_RE.test(spec)) continue;

    const parsedConfig = safeParseJsonObject(row.config);
    const enabled = resolveUserPluginEnabled(row, parsedConfig);
    if (!enabled) {
      explicitDisabled = true;
    }

    const apiKey = extractApiKeyFromTavilyRecord(parsedConfig, envMap);
    if (!apiKey) continue;

    const extracted: ExtractedLegacyTavilyConfig = {
      apiKey,
      enabled,
      source: LegacyTavilySource.UserPlugins,
    };
    if (enabled) {
      return { config: extracted, explicitDisabled: false };
    }
    if (!fallbackCandidate) {
      fallbackCandidate = extracted;
    }
  }

  return { config: fallbackCandidate, explicitDisabled };
}

function extractFromOpenClawConfig(
  configObj: Record<string, unknown> | null | undefined,
  source: LegacyTavilySource,
  envMap: Record<string, string>,
): ExtractedLegacyTavilyConfig | null {
  if (!configObj) return null;

  const pluginsBlock = asRecord(configObj.plugins);
  const deniedPlugins = new Set(
    Array.isArray(pluginsBlock?.deny)
      ? pluginsBlock.deny
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toLowerCase())
      : [],
  );

  const entriesBlock = asRecord(pluginsBlock?.entries);
  if (entriesBlock) {
    let fallbackEntry: ExtractedLegacyTavilyConfig | null = null;
    for (const [entryId, rawEntry] of Object.entries(entriesBlock)) {
      if (!TAVILY_NAME_RE.test(entryId)) continue;
      const entry = asRecord(rawEntry);
      if (!entry) continue;
      const entryConfig = asRecord(entry.config);
      const enabled =
        entry.enabled !== false
        && entryConfig?.enabled !== false
        && !deniedPlugins.has(entryId.toLowerCase());

      const apiKey =
        extractApiKeyFromTavilyRecord(entryConfig, envMap)
        ?? extractApiKeyFromTavilyRecord(entry, envMap)
        ?? resolveKeyString(envMap[TAVILY_API_KEY_ENV], envMap);
      if (!apiKey) continue;

      const candidate: ExtractedLegacyTavilyConfig = { apiKey, enabled, source };
      if (enabled) return candidate;
      if (!fallbackEntry) fallbackEntry = candidate;
    }
    if (fallbackEntry) return fallbackEntry;
  }

  const toolsBlock = asRecord(configObj.tools);
  const webBlock = asRecord(toolsBlock?.web);
  const searchBlock = asRecord(webBlock?.search);
  if (searchBlock) {
    const tavilyBlock = asRecord(searchBlock.tavily);
    const provider = typeof searchBlock.provider === 'string' ? searchBlock.provider.trim() : '';
    const isTavilyProvider = TAVILY_NAME_RE.test(provider);

    if (tavilyBlock) {
      const enabled = searchBlock.enabled !== false && tavilyBlock.enabled !== false;
      const apiKey =
        extractApiKeyFromTavilyRecord(tavilyBlock, envMap)
        ?? (isTavilyProvider ? resolveKeyString(envMap[TAVILY_API_KEY_ENV], envMap) : null);
      if (apiKey) {
        return { apiKey, enabled, source };
      }
    }

    if (isTavilyProvider) {
      const enabled = searchBlock.enabled !== false;
      const apiKey =
        extractApiKeyFromTavilyRecord(searchBlock, envMap)
        ?? resolveKeyString(envMap[TAVILY_API_KEY_ENV], envMap);
      if (apiKey) {
        return { apiKey, enabled, source };
      }
    }

    // Direct `tvly-` key in `tools.web.search.apiKey` even if provider omitted.
    const directKey = resolveKeyString(searchBlock.apiKey, envMap);
    if (directKey && directKey.startsWith('tvly-')) {
      return {
        apiKey: directKey,
        enabled: searchBlock.enabled !== false,
        source,
      };
    }
  }

  return null;
}

/**
 * Pure extractor locating a legacy OpenClaw plugin-based or `tools.web.search`
 * Tavily configuration across `user_plugins`, `openclaw.user.json`, and
 * `openclaw.json`, preserving its API key and enabled/disabled state.
 */
export function extractLegacyTavilyConfig(
  input: LegacyTavilyExtractionInput,
): ExtractedLegacyTavilyConfig | null {
  const envMap = collectEnvMap(input.openclawConfig, input.openclawUserConfig);

  const fromPlugins = extractFromUserPlugins(input.userPlugins ?? [], envMap);
  if (fromPlugins.config) {
    return fromPlugins.config;
  }

  const fromUserJson = extractFromOpenClawConfig(
    input.openclawUserConfig,
    LegacyTavilySource.OpenClawUserJson,
    envMap,
  );
  if (fromUserJson) {
    return fromPlugins.explicitDisabled ? { ...fromUserJson, enabled: false } : fromUserJson;
  }

  const fromMainJson = extractFromOpenClawConfig(
    input.openclawConfig,
    LegacyTavilySource.OpenClawJson,
    envMap,
  );
  if (fromMainJson) {
    return fromPlugins.explicitDisabled ? { ...fromMainJson, enabled: false } : fromMainJson;
  }

  return null;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function getTableColumns(db: Database.Database, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) return new Set();
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((r) => String(r.name ?? '')).filter(Boolean));
}

export function hasExistingTavilyMcpServer(db: Database.Database): boolean {
  if (!tableExists(db, 'mcp_servers')) return false;
  const cols = getTableColumns(db, 'mcp_servers');
  if (!cols.has('name') && !cols.has('config_json')) return false;

  const selectCols = ['id', 'name', 'config_json'].filter((c) => cols.has(c)).join(', ');
  const rows = db.prepare(`SELECT ${selectCols} FROM mcp_servers`).all() as Array<{
    id?: string;
    name?: string;
    config_json?: string;
  }>;

  for (const row of rows) {
    if (typeof row.name === 'string' && TAVILY_NAME_RE.test(row.name)) {
      return true;
    }
    const cfg = safeParseJsonObject(row.config_json);
    if (!cfg) continue;
    if (typeof cfg.registryId === 'string' && cfg.registryId.trim().toLowerCase() === TAVILY_MCP_REGISTRY_ID) {
      return true;
    }
    if (typeof cfg.command === 'string' && TAVILY_NAME_RE.test(cfg.command)) {
      return true;
    }
    if (typeof cfg.url === 'string' && TAVILY_NAME_RE.test(cfg.url)) {
      return true;
    }
    if (Array.isArray(cfg.args) && cfg.args.some((arg) => typeof arg === 'string' && TAVILY_NAME_RE.test(arg))) {
      return true;
    }
    const envBlock = asRecord(cfg.env);
    if (envBlock && typeof envBlock[TAVILY_API_KEY_ENV] === 'string') {
      return true;
    }
  }
  return false;
}

/**
 * Migrate a legacy plugin/search Tavily config into SQLite `mcp_servers` as
 * `npx -y tavily-mcp@latest` with `TAVILY_API_KEY` while preserving its
 * enabled/disabled state. No-ops when a Tavily MCP server already exists.
 */
export function migrateLegacyTavilyPluginToMcp(options: {
  db: Database.Database;
  openclawStateDir?: string;
  userPluginsOverride?: LegacyUserPluginRow[];
  openclawUserConfigOverride?: Record<string, unknown> | null;
  openclawConfigOverride?: Record<string, unknown> | null;
  nowMs?: number;
}): MigrateLegacyTavilyResult {
  const { db, openclawStateDir } = options;
  if (hasExistingTavilyMcpServer(db)) {
    return { migrated: false, skippedReason: 'already_exists' };
  }

  let userPlugins: LegacyUserPluginRow[] = options.userPluginsOverride ?? [];
  if (userPlugins.length === 0 && tableExists(db, 'user_plugins')) {
    try {
      userPlugins = db.prepare('SELECT * FROM user_plugins').all() as LegacyUserPluginRow[];
    } catch {
      userPlugins = [];
    }
  }

  const openclawUserConfig = options.openclawUserConfigOverride !== undefined
    ? options.openclawUserConfigOverride
    : (openclawStateDir ? safeReadJsonObject(path.join(openclawStateDir, 'openclaw.user.json')) : null);
  const openclawConfig = options.openclawConfigOverride !== undefined
    ? options.openclawConfigOverride
    : (openclawStateDir ? safeReadJsonObject(path.join(openclawStateDir, 'openclaw.json')) : null);

  const extracted = extractLegacyTavilyConfig({
    userPlugins,
    openclawUserConfig,
    openclawConfig,
  });
  if (!extracted) {
    return { migrated: false, skippedReason: 'not_found' };
  }

  if (!tableExists(db, 'mcp_servers')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  const cols = getTableColumns(db, 'mcp_servers');
  const nowMs = options.nowMs ?? Date.now();
  const serverId = crypto.randomUUID();
  const configJson = JSON.stringify({
    command: TAVILY_MCP_DEFAULT_COMMAND,
    args: [...TAVILY_MCP_DEFAULT_ARGS],
    env: {
      [TAVILY_API_KEY_ENV]: extracted.apiKey,
    },
    registryId: TAVILY_MCP_REGISTRY_ID,
  });

  const candidateValues: Array<[string, unknown]> = [
    ['id', serverId],
    ['name', TAVILY_MCP_DEFAULT_NAME],
    ['description', TAVILY_MCP_DEFAULT_DESCRIPTION],
    ['enabled', extracted.enabled ? 1 : 0],
    ['transport_type', 'stdio'],
    ['config_json', configJson],
    ['created_at', nowMs],
    ['updated_at', nowMs],
  ];
  const presentEntries = candidateValues.filter(([col]) => cols.has(col));
  if (presentEntries.length === 0) {
    return { migrated: false, skippedReason: 'not_found' };
  }

  const columnSql = presentEntries.map(([col]) => col).join(', ');
  const placeholders = presentEntries.map(() => '?').join(', ');
  db.prepare(`INSERT INTO mcp_servers (${columnSql}) VALUES (${placeholders})`).run(
    ...presentEntries.map(([, val]) => val),
  );

  return {
    migrated: true,
    serverId,
    enabled: extracted.enabled,
    source: extracted.source,
  };
}
