// Persistence helpers for resolving LobsterAI's initial DSH default
// permission preset from SQLite `kv` with legacy `cowork_config.executionMode`
// fallback. Zero Electron imports so it stays directly unit-testable in Node.

import type Database from 'better-sqlite3';

import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DSH_PERMISSION_PRESET_KV_KEY,
  type DshPermissionPreset,
  mapLegacyExecutionModeToPermissionPreset,
  parseDshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';

export interface DshPermissionPresetKvPort {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function readLegacyCoworkExecutionMode(db: Database.Database): string | null {
  try {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cowork_config'")
      .get();
    if (!exists) return null;
    const row = db
      .prepare("SELECT value FROM cowork_config WHERE key = 'executionMode'")
      .get() as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the initial default DSH permission preset on startup:
 * 1. Honor `kv['dsh.permissionPreset.default']` when present and valid.
 * 2. Otherwise fall back to legacy `cowork_config.executionMode` (`'auto'` ->
 *    `'danger-full-access'`, `'local'`/`'sandbox'` -> `'workspace-write'`) and
 *    persist it into `kv['dsh.permissionPreset.default']` so future boots and
 *    explicit user changes use a single source of truth.
 * 3. Otherwise default to `DEFAULT_DSH_PERMISSION_PRESET` (`'workspace-write'`).
 */
export function resolveInitialDshPermissionPreset(
  db: Database.Database,
  kvStorage: DshPermissionPresetKvPort,
): DshPermissionPreset {
  const stored = parseDshPermissionPreset(kvStorage.get(DSH_PERMISSION_PRESET_KV_KEY));
  if (stored) {
    return stored;
  }

  const migrated = mapLegacyExecutionModeToPermissionPreset(readLegacyCoworkExecutionMode(db));
  if (migrated) {
    kvStorage.set(DSH_PERMISSION_PRESET_KV_KEY, migrated);
    return migrated;
  }

  return DEFAULT_DSH_PERMISSION_PRESET;
}
