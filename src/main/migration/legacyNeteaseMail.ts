import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { NeteaseMailAuth, NeteaseMailScope } from '../../shared/neteaseMail/constants';
import { getNeteaseMailScopes } from '../../shared/neteaseMail/scopes';
import { readNeteaseMailAuthorization } from '../mcp/neteaseMailAuthorizationState';
import { mailTokenRecord } from '../mcp/neteaseMailAuthStore';
import { getNeteaseMailOAuthConfig } from '../mcp/neteaseMailConfig';
import type { NeteaseMailCredential } from '../mcp/neteaseMailOAuth';

type OpenDb = (file: string) => { db: Database.Database; close(): void } | null;

function jsonCell(db: Database.Database, sql: string, key: string) {
  const row = db.prepare(sql).get(key) as { value: string } | undefined;
  return row && JSON.parse(row.value);
}

/** Follow the old SDK's selected shared owner. A stale agent copy must never revive a removed grant. */
export function readLegacyNeteaseMailToken(dir: string, server: { id: string; url?: string }, openDb: OpenDb, isPackaged = true) {
  const config = getNeteaseMailOAuthConfig(isPackaged);
  if (!config || server.url !== config.mcpUrl) return null;
  const shared = openDb(path.join(dir, 'state', 'openclaw.sqlite'));
  try {
    let profiles;
    let sharedOwner = false;
    if (shared?.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'config_machine_state'").get()) {
      const select = 'SELECT value_json AS value FROM config_machine_state WHERE state_key = ?';
      const owner = jsonCell(shared.db, select, 'auth.sharedStore');
      sharedOwner = owner?.location === 'state-db';
      if (owner && !sharedOwner && owner.location !== 'legacy-main') return null;
      if (sharedOwner) profiles = jsonCell(shared.db, select, 'authProfiles.store')?.profiles;
    }
    if (!sharedOwner) {
      const agentDir = path.join(dir, 'agents', 'main', 'agent');
      const agent = openDb(path.join(agentDir, 'openclaw-agent.sqlite'));
      try {
        if (agent?.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'auth_profile_store'").get()) {
          profiles = jsonCell(agent.db, 'SELECT store_json AS value FROM auth_profile_store WHERE store_key = ?', 'primary')?.profiles;
        } else {
          const file = path.join(agentDir, 'auth-profiles.json');
          if (fs.existsSync(file)) profiles = JSON.parse(fs.readFileSync(file, 'utf8'))?.profiles;
        }
      } finally { agent?.close(); }
    }
    const credential = profiles?.[NeteaseMailAuth.ProfileId] as NeteaseMailCredential | undefined;
    if (credential?.provider !== NeteaseMailAuth.Provider || credential.type !== NeteaseMailAuth.CredentialType
      || credential.clientId !== config.clientId || typeof credential.access !== 'string' || !credential.access
      || typeof credential.refresh !== 'string' || !credential.refresh || !Number.isFinite(credential.expires)) return null;
    const sidecar = readNeteaseMailAuthorization(dir, config.clientId);
    const scopes = (sidecar?.scopes ?? [NeteaseMailScope.Read])
      .filter(scope => credential.scope === undefined || getNeteaseMailScopes(credential.scope).includes(scope));
    if (!scopes.includes(NeteaseMailScope.Read)) return null;
    return mailTokenRecord(server.id, { ...credential, scope: scopes.join(' '), authorizationId: sidecar?.id }, config.mcpUrl);
  } catch { return null; } finally { shared?.close(); }
}
