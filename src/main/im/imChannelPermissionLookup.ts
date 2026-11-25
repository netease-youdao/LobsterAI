// Lightweight SQLite lookup for resolving an IM session's channel-level
// default DSH permission preset without depending on IMGatewayManager startup order.

import type Database from 'better-sqlite3';

import type { DshPermissionPreset } from '../../shared/dshEngine/hostConstants';
import { resolveImChannelPermissionPreset } from '../../shared/im/permissionPolicy';

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

/**
 * Look up the IM channel default permission preset for `coworkSessionId`.
 * Returns `null` when the session is not mapped to an IM channel or when that
 * channel is configured to follow the global default preset.
 */
export function lookupSessionImChannelPermissionPreset(
  db: Database.Database,
  coworkSessionId: string,
): DshPermissionPreset | null {
  const normalizedSessionId = coworkSessionId.trim();
  if (!normalizedSessionId) return null;
  if (!hasTable(db, 'im_session_mappings') || !hasTable(db, 'im_config')) {
    return null;
  }

  const mapping = db
    .prepare(
      `SELECT platform
       FROM im_session_mappings
       WHERE cowork_session_id = ?
       ORDER BY last_active_at DESC
       LIMIT 1`,
    )
    .get(normalizedSessionId) as { platform?: unknown } | undefined;

  const platform = typeof mapping?.platform === 'string' ? mapping.platform.trim() : '';
  if (!platform) return null;

  const configRow = db
    .prepare('SELECT value FROM im_config WHERE key = ?')
    .get('settings') as { value?: unknown } | undefined;
  if (typeof configRow?.value !== 'string' || !configRow.value.trim()) {
    return null;
  }

  try {
    const settings = JSON.parse(configRow.value) as {
      platformPermissionPresets?: Record<string, string | undefined>;
    };
    return resolveImChannelPermissionPreset(settings?.platformPermissionPresets, platform);
  } catch {
    return null;
  }
}
