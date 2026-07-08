import { McpServerFormData, McpTransportType } from '../types/mcp';

/**
 * Parser for the de-facto standard MCP JSON config format used by
 * Claude Desktop / Cursor / Windsurf, e.g.:
 *
 *   { "mcpServers": { "<name>": { "command": "npx", "args": [...], "env": {...} } } }
 *   { "mcpServers": { "<name>": { "type": "http", "url": "https://..." } } }
 *
 * Also accepts a bare name-to-config map (without the "mcpServers" wrapper)
 * and the VS Code style "servers" wrapper. Multiple servers per paste are
 * supported. The result maps 1:1 onto McpServerFormData, which is what the
 * regular create-server flow persists and what openclawConfigSync writes
 * into OpenClaw's native `mcp.servers`.
 */

export const McpJsonImportErrorCode = {
  InvalidJson: 'invalid-json',
  NoServers: 'no-servers',
  MissingName: 'missing-name',
  EntryInvalid: 'entry-invalid',
  DuplicateName: 'duplicate-name',
} as const;
export type McpJsonImportErrorCode = typeof McpJsonImportErrorCode[keyof typeof McpJsonImportErrorCode];

export type McpJsonImportResult =
  | { ok: true; servers: McpServerFormData[] }
  | { ok: false; code: McpJsonImportErrorCode; detail?: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string | number | boolean =>
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
    .map(item => String(item).trim())
    .filter(item => item.length > 0);
};

const toStringRecord = (value: unknown): Record<string, string> => {
  const result: Record<string, string> = {};
  if (!isPlainObject(value)) return result;
  for (const [key, raw] of Object.entries(value)) {
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      result[trimmedKey] = String(raw);
    }
  }
  return result;
};

const HTTP_TRANSPORT_ALIASES = new Set(['http', 'streamable-http', 'streamable_http', 'streamablehttp']);

/**
 * Resolve the remote transport type. Explicit "type"/"transport" wins;
 * otherwise fall back to a URL heuristic (legacy SSE endpoints conventionally
 * end with /sse), defaulting to streamable HTTP, the current MCP standard.
 */
const resolveRemoteTransport = (rawType: unknown, url: string): McpTransportType => {
  if (typeof rawType === 'string') {
    const normalized = rawType.trim().toLowerCase();
    if (normalized === 'sse') return 'sse';
    if (HTTP_TRANSPORT_ALIASES.has(normalized)) return 'http';
  }
  if (/\/sse\/?([?#]|$)/i.test(url)) return 'sse';
  return 'http';
};

const looksLikeSingleServerConfig = (value: Record<string, unknown>): boolean =>
  typeof value.command === 'string' || typeof value.url === 'string' || typeof value.serverUrl === 'string';

export function parseMcpServersJson(input: string): McpJsonImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, code: McpJsonImportErrorCode.InvalidJson };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, code: McpJsonImportErrorCode.NoServers };
  }

  let serverMap: Record<string, unknown>;
  if (isPlainObject(parsed.mcpServers)) {
    serverMap = parsed.mcpServers;
  } else if (isPlainObject(parsed.servers)) {
    serverMap = parsed.servers;
  } else if (looksLikeSingleServerConfig(parsed)) {
    // A single config object pasted without a name key.
    return { ok: false, code: McpJsonImportErrorCode.MissingName };
  } else {
    serverMap = parsed;
  }

  const entries = Object.entries(serverMap);
  if (entries.length === 0) {
    return { ok: false, code: McpJsonImportErrorCode.NoServers };
  }

  const servers: McpServerFormData[] = [];
  const seenNames = new Set<string>();
  for (const [rawName, rawConfig] of entries) {
    const name = rawName.trim();
    if (!name || !isPlainObject(rawConfig)) {
      return { ok: false, code: McpJsonImportErrorCode.EntryInvalid, detail: name || rawName };
    }
    if (seenNames.has(name)) {
      return { ok: false, code: McpJsonImportErrorCode.DuplicateName, detail: name };
    }
    seenNames.add(name);

    const description = typeof rawConfig.description === 'string' ? rawConfig.description.trim() : '';
    const command = typeof rawConfig.command === 'string' ? rawConfig.command.trim() : '';
    const url = typeof rawConfig.url === 'string'
      ? rawConfig.url.trim()
      : typeof rawConfig.serverUrl === 'string' ? rawConfig.serverUrl.trim() : '';

    if (command) {
      servers.push({
        name,
        description,
        transportType: 'stdio',
        command,
        args: toStringArray(rawConfig.args),
        env: toStringRecord(rawConfig.env),
      });
    } else if (url) {
      servers.push({
        name,
        description,
        transportType: resolveRemoteTransport(rawConfig.type ?? rawConfig.transport, url),
        url,
        headers: toStringRecord(rawConfig.headers),
      });
    } else {
      return { ok: false, code: McpJsonImportErrorCode.EntryInvalid, detail: name };
    }
  }

  return { ok: true, servers };
}
