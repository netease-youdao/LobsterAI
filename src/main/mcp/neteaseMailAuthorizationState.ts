import fs from 'node:fs';
import path from 'node:path';

import { type NeteaseMailScope } from '../../shared/neteaseMail/constants';
import { getNeteaseMailScopes } from '../../shared/neteaseMail/scopes';

// Read the non-secret scope sidecar written by the OpenClaw mail integration.
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
