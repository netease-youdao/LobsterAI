import fs from 'fs';
import path from 'path';

import { AgentId } from '../../shared/agent/constants';

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

function hasLegacySharedSessionStore(stateDir: string): boolean {
  try {
    fs.lstatSync(path.join(stateDir, 'sessions', 'sessions.json'));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    // Do not discard ownership evidence when the migration source is unreadable.
    throw error;
  }
}

/**
 * Keep the legacy owner through Doctor import and for fixed stores. Normal
 * per-agent configs must not continually re-add an owner removed by config.set.
 * Explicit owners remain authoritative, including retired-main migration owners.
 */
export function withRequiredOpenClawSessionStoreOwner(
  config: Record<string, unknown>,
  options: { stateDir?: string; legacyOwner?: unknown } = {},
): Record<string, unknown> {
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents?.defaults);
  const sessionStore = asRecord(defaults?.sessionStore);
  // Preserve authored values, including invalid ones for upstream validation.
  if (defaults?.sessionStore !== undefined
    && (!sessionStore || Object.hasOwn(sessionStore, 'agentId'))) return config;

  const store = asRecord(config.session)?.store;
  const fixedStore = typeof store === 'string' && !!store.trim() && !store.includes('{agentId}');
  const legacySharedStore = options.stateDir ? hasLegacySharedSessionStore(options.stateDir) : false;
  if (!fixedStore && !legacySharedStore) return config;

  const previousOwner = asRecord(options.legacyOwner);
  const owner = legacySharedStore && typeof previousOwner?.agentId === 'string' && previousOwner.agentId.trim()
    ? previousOwner
    : { agentId: AgentId.Main };
  return {
    ...config,
    agents: {
      ...agents,
      defaults: { ...defaults, sessionStore: { ...sessionStore, ...owner } },
    },
  };
}
