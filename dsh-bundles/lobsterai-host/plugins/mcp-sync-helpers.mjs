/**
 * Pure differential MCP reconciliation helpers for `lobster-ops-rpc`.
 * Zero DSH peer imports so Vitest can test them directly.
 */

const MAX_DSH_TIMEOUT_MS = 2_147_483_647;

/**
 * Normalize a positive finite timeout value to DSH's valid timer range.
 * @param {unknown} value
 * @returns {number | undefined}
 */
function normalizeTimeoutMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return undefined;
  }
  return Math.min(Math.floor(value), MAX_DSH_TIMEOUT_MS);
}

/**
 * Normalize a plain object into a key-sorted string dictionary.
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function normalizeStringRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw)
    .map(([k, v]) => [String(k), String(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

/**
 * Canonical JSON serialization with recursively sorted object keys so spec
 * fingerprints are stable regardless of property insertion order.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

/**
 * Validate and normalize one incoming MCP server spec into the registration
 * shape expected by `ctx.mcpManager.register(name, config)` plus a canonical
 * change-detection fingerprint.
 *
 * Returns `null` for disabled or structurally empty entries.
 * Returns `{ name, error }` when an enabled entry has an invalid endpoint/command.
 * @param {unknown} entry
 * @returns {{ name: string, config: Record<string, unknown>, fingerprint: string } | { name: string, error: string } | null}
 */
export function normalizeMcpServerEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const serverName = String(entry.name || '').trim();
  if (!serverName || entry.enabled === false) return null;

  const transport = entry.transport === 'streamable-http' ? 'streamable-http' : 'stdio';
  const startupTimeoutMs = normalizeTimeoutMs(entry.startupTimeoutMs);
  const toolCallTimeoutMs = normalizeTimeoutMs(entry.toolCallTimeoutMs);

  if (transport === 'stdio') {
    const command = String(entry.command || '').trim();
    if (!command) {
      return { name: serverName, error: `${serverName}: stdio server requires "command"` };
    }
    const config = {
      transport: 'stdio',
      command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: normalizeStringRecord(entry.env),
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
      ...(toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs } : {}),
    };
    return { name: serverName, config, fingerprint: canonicalJson(config) };
  }

  const url = String(entry.url || '').trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { name: serverName, error: `${serverName}: unsupported URL protocol "${parsed.protocol}"` };
    }
  } catch {
    return { name: serverName, error: `${serverName}: invalid streamable-http URL` };
  }

  const config = {
    transport: 'streamable-http',
    url,
    headers: normalizeStringRecord(entry.headers),
    ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
    ...(toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs } : {}),
  };
  return { name: serverName, config, fingerprint: canonicalJson(config) };
}

/**
 * Differentially reconcile live LobsterAI-managed MCP registrations against the
 * desired server list:
 * - Unchanged servers remain mounted untouched (zero teardown/respawn churn).
 * - Removed or disabled servers are disposed.
 * - Added or modified servers are disposed (if previously mounted) and registered.
 *
 * @param {{
 *   managedEntries: Map<string, { fingerprint: string, dispose: () => unknown }>,
 *   servers: unknown[],
 *   register: (name: string, config: Record<string, unknown>) => (() => unknown),
 *   logger?: { warn?: (message: string) => void },
 *   afterDispose?: (removedNames: string[]) => Promise<void> | void,
 * }} params
 */
export async function reconcileMcpServers(params) {
  const { managedEntries, servers, register, logger, afterDispose } = params;
  /** @type {Map<string, { config: Record<string, unknown>, fingerprint: string }>} */
  const desired = new Map();
  /** @type {string[]} */
  const errors = [];

  for (const rawEntry of Array.isArray(servers) ? servers : []) {
    const normalized = normalizeMcpServerEntry(rawEntry);
    if (!normalized) continue;
    if ('error' in normalized) {
      errors.push(normalized.error);
      logger?.warn?.(`[LobsterAI:OpsRpc] skipping invalid MCP server: ${normalized.error}`);
      continue;
    }
    desired.set(normalized.name, {
      config: normalized.config,
      fingerprint: normalized.fingerprint,
    });
  }

  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const unchanged = [];
  /** @type {Set<string>} */
  const modifiedNames = new Set();

  for (const [existingName, existingRecord] of [...managedEntries.entries()]) {
    const next = desired.get(existingName);
    if (next && next.fingerprint === existingRecord.fingerprint) {
      unchanged.push(existingName);
      continue;
    }

    managedEntries.delete(existingName);
    try {
      await existingRecord.dispose();
    } catch (error) {
      logger?.warn?.(
        `[LobsterAI:OpsRpc] failed to dispose MCP server "${existingName}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (next) {
      modifiedNames.add(existingName);
    } else {
      removed.push(existingName);
    }
  }

  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const updated = [];

  for (const [serverName, { config, fingerprint }] of desired.entries()) {
    if (managedEntries.has(serverName)) continue;
    try {
      const dispose = register(serverName, config);
      managedEntries.set(serverName, { fingerprint, dispose });
      if (modifiedNames.has(serverName)) {
        updated.push(serverName);
      } else {
        added.push(serverName);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${serverName}: ${detail}`);
      logger?.warn?.(`[LobsterAI:OpsRpc] failed to register MCP server "${serverName}": ${detail}`);
    }
  }

  if (removed.length > 0 && typeof afterDispose === 'function') {
    await afterDispose(removed);
  }

  return {
    registered: [...managedEntries.keys()],
    added,
    updated,
    removed,
    unchanged,
    errors,
  };
}
