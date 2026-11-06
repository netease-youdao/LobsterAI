import fs from 'node:fs';
import path from 'node:path';

// Wire contract with the Electron worker; this file contains no bearer or refresh token.
export const AUTHORIZATION_FILE = 'netease-mail-authorization.json';
export interface MailAuthorization { version: 1; clientId: string; id: string; scopes: string[] }

export function readMailAuthorization(stateDir: string, clientId: string): MailAuthorization | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(stateDir, AUTHORIZATION_FILE), 'utf8')) as MailAuthorization;
    if (value.version !== 1 || value.clientId !== clientId || typeof value.id !== 'string' || !value.id
      || !Array.isArray(value.scopes) || value.scopes.some(scope => typeof scope !== 'string')) return undefined;
    return value;
  } catch { return undefined; }
}
