import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type NeteaseMailScope } from '../../shared/neteaseMail/constants';
import { getNeteaseMailScopes } from '../../shared/neteaseMail/scopes';

// Public provider-auth deliberately strips nonstandard OAuth fields. Keep only
// non-secret grant metadata here; tokens remain exclusively in its native store.
const AUTHORIZATION_FILE = 'netease-mail-authorization.json';
interface AuthorizationState { version: 1; clientId: string; id: string; scopes: NeteaseMailScope[] }

export function readNeteaseMailAuthorization(stateDir: string, clientId: string): AuthorizationState | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(stateDir, AUTHORIZATION_FILE), 'utf8')) as AuthorizationState;
    if (value.version !== 1 || value.clientId !== clientId || typeof value.id !== 'string' || !value.id
      || !Array.isArray(value.scopes) || value.scopes.some(scope => typeof scope !== 'string')) return undefined;
    return { ...value, scopes: getNeteaseMailScopes(value.scopes.join(' ')) };
  } catch { return undefined; }
}

export function clearNeteaseMailAuthorization(stateDir: string): void {
  fs.rmSync(path.join(stateDir, AUTHORIZATION_FILE), { force: true });
}

export function saveNeteaseMailAuthorization(stateDir: string, credential: { clientId: string; scope?: string; authorizationId?: string }): void {
  const target = path.join(stateDir, AUTHORIZATION_FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, clientId: credential.clientId,
      id: credential.authorizationId ?? randomUUID(), scopes: getNeteaseMailScopes(credential.scope) }), { mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}
