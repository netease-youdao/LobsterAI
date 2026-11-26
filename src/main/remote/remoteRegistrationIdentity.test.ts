import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import { loadRemoteIdentity } from './installationIdentity';
import { RemoteRegistrationIdentityStore } from './remoteRegistrationIdentity';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
test('persists only transport rotation, preserves the security identity, and isolates accounts and routes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'remote-registration-')); directories.push(directory);
  const profile = path.join(directory, 'profile'); mkdirSync(profile);
  const cipher = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (data: Buffer) => data.toString() };
  const original = loadRemoteIdentity(directory, profile, cipher);
  const owner = { userId: 'user', scopeKey: 'personal' }, route = 'https://example.com';
  const store = new RemoteRegistrationIdentityStore(directory, profile, cipher, original);
  expect(store.get(owner, route)).toEqual(original);
  const next = store.replace(owner, route);
  expect(next.installationId).not.toBe(original.installationId);
  expect(next.deviceKey).not.toBe(original.deviceKey);
  expect(next.databaseId).toBe(original.databaseId);
  expect(loadRemoteIdentity(directory, profile, cipher)).toEqual(original);
  const restarted = new RemoteRegistrationIdentityStore(directory, profile, cipher, original);
  expect(restarted.get(owner, route)).toEqual(next);
  expect(restarted.get({ ...owner, scopeKey: 'enterprise' }, route)).toEqual(original);
  expect(restarted.get({ ...owner, userId: 'other' }, route)).toEqual(original);
  expect(restarted.get(owner, 'https://other.example')).toEqual(original);
  const parent = path.join(directory, 'LobsterAI-remote-identity');
  const credentials = path.join(parent, readdirSync(parent)[0], 'registrations');
  const filename = path.join(credentials, readdirSync(credentials)[0]);
  const before = readFileSync(filename);
  const failing = new RemoteRegistrationIdentityStore(directory, profile, { ...cipher, encryptString: () => { throw new Error('locked'); } }, original);
  expect(() => failing.replace(owner, route)).toThrow('locked');
  expect(readFileSync(filename)).toEqual(before);
  expect(readdirSync(credentials)).toHaveLength(1);
  writeFileSync(filename, '{}');
  expect(() => restarted.get(owner, route)).toThrow('Invalid remote registration identity');
});
