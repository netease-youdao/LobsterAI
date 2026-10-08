// The desktop calls this bundled owner with an explicit state directory. Keep
// credentials in OpenClaw's transactions, ownership and snapshot publication.
import fs from 'node:fs';
import path from 'node:path';
import { coercePersistedAuthProfileStore, loadPersistedAuthProfileStore } from '#openclaw-auth-profile-persisted';
import { closeAuthProfileReadPool, inspectPersistedSharedAuthProfileStoreRaw, inspectPersistedAuthProfileStoreRaw, runAuthProfileWriteTransaction } from '#openclaw-auth-profile-sqlite';
import { saveAuthProfileStoreWithPreparedOwner } from '#openclaw-auth-profile-store';
import { removeRuntimeExternalProfileReferences } from '#openclaw-auth-profile-references';
import { reloadSharedAuthStoreOwnership } from '#openclaw-auth-profile-paths';
import { closeOpenClawAgentDatabases } from '#openclaw-agent-database';
import { closeOpenClawStateDatabaseByPath } from '#openclaw-state-database';
import { listLegacyAuthProfileSources } from '#openclaw-auth-migration-diagnostic';
import { XAI_AUTH_PROVIDER, XAI_AUTH_CREDENTIAL_TYPE, XaiAuthStoreErrorCode } from '../src/shared/openclawEngine/xaiAuthStore.ts';

function environment(stateDir) {
  if (!path.isAbsolute(stateDir)) throw new Error('xAI auth requires an absolute OpenClaw state directory.');
  return {
    OPENCLAW_HOME: path.dirname(stateDir),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'),
  };
}

function xaiEntries(store) {
  return Object.entries(store?.profiles ?? {}).filter(([, credential]) =>
    credential?.provider === XAI_AUTH_PROVIDER && credential.type === XAI_AUTH_CREDENTIAL_TYPE);
}

function withOwner(stateDir, operation) {
  const env = environment(stateDir);
  try {
    // Startup migration and Gateway run in other processes. Do not retain an
    // ownership decision or open connection across their schema/owner changes.
    reloadSharedAuthStoreOwnership(env);
    return operation(env);
  } finally {
    closeAuthProfileReadPool({ kind: 'root', rootPath: stateDir });
    closeOpenClawAgentDatabases(stateDir);
    closeOpenClawStateDatabaseByPath(path.join(stateDir, 'state', 'openclaw.sqlite'));
  }
}

function status(store) {
  const credential = xaiEntries(store)[0]?.[1];
  if (!credential) return { loggedIn: false };
  return {
    loggedIn: true,
    ...(typeof credential.email === 'string' && credential.email.trim() ? { email: credential.email.trim() } : {}),
    ...(typeof credential.displayName === 'string' && credential.displayName.trim() ? { displayName: credential.displayName.trim() } : {}),
    ...(typeof credential.expires === 'number' && credential.expires > 0 ? { expiresAt: credential.expires } : {}),
  };
}

export function readStatus(stateDir) {
  return withOwner(stateDir, env => readStatusFromOwner(stateDir, env));
}

function readStatusFromOwner(stateDir, env) {
  const inspected = inspectPersistedSharedAuthProfileStoreRaw(env);
  if (inspected.status === 'unreadable') throw new Error('The OpenClaw xAI auth store is unreadable.');
  if (inspected.status === 'readable') {
    const store = coercePersistedAuthProfileStore(inspected.raw);
    if (!store) throw new Error('The OpenClaw xAI auth store has an invalid shape.');
    // A canonical empty store (including logout) wins over recreated old JSON.
    return status(store);
  }
  // Before startup migration, config sync needs only login metadata to keep
  // the xAI provider enabled. Never write or return credentials from this source.
  try {
    return status(coercePersistedAuthProfileStore(JSON.parse(fs.readFileSync(
      path.join(stateDir, 'agents', 'main', 'agent', 'auth-profiles.json'), 'utf8',
    ))));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { loggedIn: false };
    throw error;
  }
}

function update(stateDir, env, credentialEntry) {
  const sources = listLegacyAuthProfileSources({ agentDir: path.join(stateDir, 'agents', 'main', 'agent'), env });
  if (sources.length) throw Object.assign(new Error('OpenClaw credential migration is pending.'), {
    code: XaiAuthStoreErrorCode.MigrationPending,
  });
  runAuthProfileWriteTransaction(undefined, (database, owner) => {
    const inspected = inspectPersistedAuthProfileStoreRaw(undefined, database);
    const current = loadPersistedAuthProfileStore(undefined, { database });
    if (inspected.status !== 'missing' && !current) throw new Error('The OpenClaw xAI auth store is unreadable.');
    const store = current ?? { version: 1, profiles: {} };
    const next = removeRuntimeExternalProfileReferences({
      store, profileIds: new Set(xaiEntries(store).map(([id]) => id)),
    });
    if (credentialEntry) {
      const [profileId, credential] = credentialEntry;
      next.profiles[profileId] = structuredClone(credential);
    }
    saveAuthProfileStoreWithPreparedOwner(next, undefined,
      { filterExternalAuthProfiles: false, syncExternalCli: false }, database, owner);
  }, { env, sharedStoreWrite: true });
}

export function replaceCredential(stateDir, profileId, credential) {
  if (typeof profileId !== 'string' || !profileId.startsWith(`${XAI_AUTH_PROVIDER}:`)
    || credential?.provider !== XAI_AUTH_PROVIDER || credential.type !== XAI_AUTH_CREDENTIAL_TYPE
    || typeof credential.access !== 'string' || !credential.access.trim()) {
    throw new Error('Invalid xAI OAuth credential.');
  }
  withOwner(stateDir, env => update(stateDir, env, [profileId, credential]));
}

export function logout(stateDir) {
  withOwner(stateDir, env => update(stateDir, env));
}
