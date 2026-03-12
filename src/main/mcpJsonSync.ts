import fs from 'fs';
import path from 'path';
import { McpServerFormData, McpServerRecord, McpServerSource } from './mcpStore';

type McpJsonTransport = 'stdio' | 'sse' | 'http';

interface McpJsonServerShape {
  type?: unknown;
  transportType?: unknown;
  description?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
}

interface McpJsonRootShape {
  mcpServers?: unknown;
}

interface SyncStoreLike {
  listServers(): McpServerRecord[];
  createServer(data: McpServerFormData): McpServerRecord;
  updateServer(id: string, data: Partial<McpServerFormData>): McpServerRecord | null;
  deleteServer(id: string): boolean;
}

export interface McpJsonSyncResult {
  filePath: string;
  found: boolean;
  added: string[];
  updated: string[];
  removed: string[];
  conflicts: string[];
  invalid: string[];
}

interface NormalizedServer {
  name: string;
  data: McpServerFormData;
}

const MCP_JSON_FILE_NAME = 'mcp.json';

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const normalizeStringMap = (value: unknown): Record<string, string> | undefined => {
  if (!isPlainObject(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
      continue;
    }
    if (typeof entry === 'number' || typeof entry === 'boolean') {
      result[key] = String(entry);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter((entry): entry is string | number | boolean => (
      typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean'
    ))
    .map((entry) => String(entry));
  return result.length > 0 ? result : undefined;
};

const normalizeTransportType = (rawTransport: unknown, rawServer: McpJsonServerShape): McpJsonTransport | null => {
  const normalized = typeof rawTransport === 'string'
    ? rawTransport.trim().toLowerCase()
    : '';

  switch (normalized) {
    case 'stdio':
      return 'stdio';
    case 'sse':
      return 'sse';
    case 'http':
    case 'streamable_http':
    case 'streamable-http':
      return 'http';
    case '':
      if (typeof rawServer.command === 'string' && rawServer.command.trim()) {
        return 'stdio';
      }
      if (typeof rawServer.url === 'string' && rawServer.url.trim()) {
        return 'http';
      }
      return null;
    default:
      return null;
  }
};

const createSource = (filePath: string): McpServerSource => ({
  kind: 'mcp-json',
  filePath,
});

const isManagedBySource = (server: McpServerRecord, source: McpServerSource): boolean => {
  return server.source?.kind === source.kind && server.source.filePath === source.filePath;
};

const configsMatch = (existing: McpServerRecord, incoming: McpServerFormData): boolean => {
  return existing.description === incoming.description
    && existing.transportType === incoming.transportType
    && existing.command === incoming.command
    && JSON.stringify(existing.args ?? []) === JSON.stringify(incoming.args ?? [])
    && JSON.stringify(existing.env ?? {}) === JSON.stringify(incoming.env ?? {})
    && existing.url === incoming.url
    && JSON.stringify(existing.headers ?? {}) === JSON.stringify(incoming.headers ?? {})
    && existing.isBuiltIn === Boolean(incoming.isBuiltIn)
    && existing.githubUrl === incoming.githubUrl
    && existing.registryId === incoming.registryId
    && JSON.stringify(existing.source ?? null) === JSON.stringify(incoming.source ?? null);
};

export const normalizeMcpJsonServer = (
  name: string,
  rawValue: unknown,
  filePath: string,
): NormalizedServer | { error: string } => {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return { error: 'Server name is empty' };
  }
  if (!isPlainObject(rawValue)) {
    return { error: 'Server config must be an object' };
  }

  const rawServer = rawValue as McpJsonServerShape;
  const transportType = normalizeTransportType(rawServer.type ?? rawServer.transportType, rawServer);
  if (!transportType) {
    return { error: `Unsupported transport type: ${String(rawServer.type ?? rawServer.transportType ?? '(missing)')}` };
  }

  const data: McpServerFormData = {
    name: trimmedName,
    description: typeof rawServer.description === 'string' ? rawServer.description.trim() : '',
    transportType,
    source: createSource(filePath),
  };

  if (transportType === 'stdio') {
    const command = typeof rawServer.command === 'string' ? rawServer.command.trim() : '';
    if (!command) {
      return { error: 'stdio transport requires a command' };
    }
    data.command = command;
    const args = normalizeStringArray(rawServer.args);
    if (args) data.args = args;
    const env = normalizeStringMap(rawServer.env);
    if (env) data.env = env;
  } else {
    const url = typeof rawServer.url === 'string' ? rawServer.url.trim() : '';
    if (!url) {
      return { error: `${transportType} transport requires a url` };
    }
    data.url = url;
    const headers = normalizeStringMap(rawServer.headers);
    if (headers) data.headers = headers;
  }

  return {
    name: trimmedName,
    data,
  };
};

const parseMcpJsonFile = (
  filePath: string,
): { servers: NormalizedServer[]; invalid: string[]; error?: string } => {
  let rawText: string;
  try {
    rawText = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { servers: [], invalid: [], error: error instanceof Error ? error.message : String(error) };
  }

  let parsed: McpJsonRootShape;
  try {
    parsed = JSON.parse(rawText) as McpJsonRootShape;
  } catch (error) {
    return { servers: [], invalid: [], error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
    return { servers: [], invalid: [], error: 'mcp.json must contain an object-valued "mcpServers" field' };
  }

  const normalizedServers: NormalizedServer[] = [];
  const invalid: string[] = [];

  for (const [name, rawServer] of Object.entries(parsed.mcpServers)) {
    const normalized = normalizeMcpJsonServer(name, rawServer, filePath);
    if ('error' in normalized) {
      invalid.push(`${name}: ${normalized.error}`);
      continue;
    }
    normalizedServers.push(normalized);
  }

  return {
    servers: normalizedServers,
    invalid,
  };
};

const removeManagedServers = (store: SyncStoreLike, source: McpServerSource): string[] => {
  const removed: string[] = [];
  for (const server of store.listServers()) {
    if (!isManagedBySource(server, source)) continue;
    if (store.deleteServer(server.id)) {
      removed.push(server.name);
    }
  }
  return removed;
};

export const syncMcpJsonFile = (
  store: SyncStoreLike,
  options: {
    userDataPath?: string;
    filePath?: string;
  } = {},
): McpJsonSyncResult => {
  const filePath = options.filePath ?? path.join(options.userDataPath ?? '', MCP_JSON_FILE_NAME);
  const source = createSource(filePath);
  const result: McpJsonSyncResult = {
    filePath,
    found: fs.existsSync(filePath),
    added: [],
    updated: [],
    removed: [],
    conflicts: [],
    invalid: [],
  };

  if (!result.found) {
    result.removed = removeManagedServers(store, source);
    return result;
  }

  const parsed = parseMcpJsonFile(filePath);
  if (parsed.error) {
    result.invalid.push(parsed.error);
    return result;
  }
  result.invalid.push(...parsed.invalid);

  const currentServers = store.listServers();
  const existingByName = new Map(currentServers.map((server) => [server.name, server]));
  const importedNames = new Set<string>();

  for (const normalized of parsed.servers) {
    importedNames.add(normalized.name);
    const existing = existingByName.get(normalized.name);
    if (!existing) {
      const created = store.createServer(normalized.data);
      existingByName.set(created.name, created);
      result.added.push(normalized.name);
      continue;
    }

    if (!isManagedBySource(existing, source)) {
      result.conflicts.push(normalized.name);
      continue;
    }

    if (configsMatch(existing, normalized.data)) {
      continue;
    }

    const updated = store.updateServer(existing.id, normalized.data);
    if (updated) {
      existingByName.set(updated.name, updated);
      result.updated.push(normalized.name);
    }
  }

  for (const server of currentServers) {
    if (!isManagedBySource(server, source)) continue;
    if (importedNames.has(server.name)) continue;
    if (store.deleteServer(server.id)) {
      result.removed.push(server.name);
    }
  }

  return result;
};

export const __mcpJsonSyncTestUtils = {
  normalizeMcpJsonServer,
  normalizeTransportType,
  syncMcpJsonFile,
};
