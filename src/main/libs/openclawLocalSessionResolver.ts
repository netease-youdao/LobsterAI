import type Database from 'better-sqlite3';

import { parseManagedSessionKey } from './openclawChannelSessionSync';

const MAX_PARENT_LOOKUP_DEPTH = 16;

const getSessionRowById = (
  db: Database.Database,
  sessionId: string,
): { id: string; parent_session_id: string | null } | null => {
  const normalized = sessionId.trim();
  if (!normalized) return null;
  const row = db
    .prepare('SELECT id, parent_session_id FROM cowork_sessions WHERE id = ? LIMIT 1')
    .get(normalized) as { id: string; parent_session_id: string | null } | undefined;
  return row ?? null;
};

const getSessionRowByClaudeSessionId = (
  db: Database.Database,
  sessionKey: string,
): { id: string; parent_session_id: string | null } | null => {
  const normalized = sessionKey.trim();
  if (!normalized) return null;
  const row = db
    .prepare('SELECT id, parent_session_id FROM cowork_sessions WHERE claude_session_id = ? LIMIT 1')
    .get(normalized) as { id: string; parent_session_id: string | null } | undefined;
  return row ?? null;
};

export function resolveCoworkSessionIdByOpenClawSessionKey(
  db: Database.Database,
  sessionKey: string | undefined | null,
): string | null {
  const normalized = (sessionKey ?? '').trim();
  if (!normalized) return null;

  const persisted = getSessionRowByClaudeSessionId(db, normalized);
  if (persisted) return persisted.id;

  const managed = parseManagedSessionKey(normalized);
  if (!managed) return null;

  const session = getSessionRowById(db, managed.sessionId);
  return session?.id ?? null;
}

export function getCoworkParentSessionId(
  db: Database.Database,
  sessionId: string | undefined | null,
): string | null {
  const normalized = (sessionId ?? '').trim();
  if (!normalized) return null;
  return getSessionRowById(db, normalized)?.parent_session_id ?? null;
}

export function isCoworkSessionBoundToIm(
  db: Database.Database,
  sessionId: string,
): boolean {
  let current: string | null = sessionId.trim();
  const seen = new Set<string>();

  for (let depth = 0; current && depth < MAX_PARENT_LOOKUP_DEPTH; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);

    const mapping = db
      .prepare('SELECT 1 FROM im_session_mappings WHERE cowork_session_id = ? LIMIT 1')
      .get(current) as { 1: number } | undefined;
    if (mapping) return true;

    current = getCoworkParentSessionId(db, current);
  }

  return false;
}

export function resolveLocalDesktopCoworkSessionIdByOpenClawSessionKey(
  db: Database.Database,
  sessionKey: string | undefined | null,
): string | null {
  const sessionId = resolveCoworkSessionIdByOpenClawSessionKey(db, sessionKey);
  if (!sessionId) return null;
  return isCoworkSessionBoundToIm(db, sessionId) ? null : sessionId;
}
