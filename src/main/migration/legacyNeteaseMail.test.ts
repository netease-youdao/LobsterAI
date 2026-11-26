import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import { NeteaseMail, NeteaseMailAuth, NeteaseMailScope } from '../../shared/neteaseMail/constants';
import { readLegacyNeteaseMailToken } from './legacyNeteaseMail';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-dsh-upgrade-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'state'));
  const agentDir = path.join(dir, 'agents', 'main', 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const pathToDb = path.join(dir, 'state', 'openclaw.sqlite');
  const db = new Database(pathToDb);
  db.exec('CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT)');
  const profiles = { [NeteaseMailAuth.ProfileId]: { provider: NeteaseMailAuth.Provider, type: NeteaseMailAuth.CredentialType,
    clientId: NeteaseMail.ClientId, access: 'sample', refresh: 'sample-refresh', expires: 1 } };
  const insert = db.prepare('INSERT INTO config_machine_state VALUES (?, ?)');
  insert.run('auth.sharedStore', JSON.stringify({ location: 'state-db' }));
  insert.run('authProfiles.store', JSON.stringify({ profiles }));
  db.close();
  const read = (url: string = NeteaseMail.Endpoint, isPackaged = true) => readLegacyNeteaseMailToken(dir, { id: 'mail', url }, file => {
    if (!fs.existsSync(file)) return null;
    const opened = new Database(file, { readonly: true });
    return { db: opened, close: () => opened.close() };
  }, isPackaged);
  return { dir, read, pathToDb, agentDir, profiles };
}

test('imports only the matching client and restores the granted scopes from the legacy profile', () => {
  const f = fixture();
  expect(f.read()).toMatchObject({ scope: NeteaseMailScope.Read, resource: NeteaseMail.Endpoint });
  expect(f.read('https://unrelated.example/mcp')).toBeNull();
  fs.writeFileSync(path.join(f.dir, 'netease-mail-authorization.json'), JSON.stringify({
    version: 1, clientId: NeteaseMail.ClientId, id: 'original-grant', scopes: Object.values(NeteaseMailScope),
  }));
  expect(f.read()).toMatchObject({ serverId: 'mail', mailAuthorizationId: 'original-grant', refreshToken: 'sample-refresh',
    scope: Object.values(NeteaseMailScope).join(' ') });
});

test('packaged migration ignores development overrides when restoring a mail grant', () => {
  const f = fixture();
  const localEndpoint = 'https://development.example/mcp';
  vi.stubEnv('LOBSTER_NETEASE_MAIL_MCP_URL', localEndpoint);
  expect(f.read()).toMatchObject({ resource: NeteaseMail.Endpoint });
  expect(f.read(localEndpoint)).toBeNull();
  expect(f.read(localEndpoint, false)).toMatchObject({ resource: localEndpoint });
});

test('the selected shared store cannot resurrect a removed account from a legacy agent file', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.agentDir, 'auth-profiles.json'), JSON.stringify({ profiles: f.profiles }));
  const db = new Database(f.pathToDb);
  db.prepare('DELETE FROM config_machine_state WHERE state_key = ?').run('authProfiles.store');
  expect(f.read()).toBeNull();
  db.prepare('UPDATE config_machine_state SET value_json = ? WHERE state_key = ?')
    .run(JSON.stringify({ location: 'legacy-main' }), 'auth.sharedStore');
  db.close();
  expect(f.read()?.scope).toBe(NeteaseMailScope.Read);
});
