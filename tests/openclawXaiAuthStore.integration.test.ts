import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  OPENCLAW_XAI_AUTH_STORE_ENTRY,
  type OpenClawXaiAuthStore,
  XAI_AUTH_CREDENTIAL_TYPE,
  XAI_AUTH_PROVIDER,
  XaiAuthStoreErrorCode,
  type XaiOAuthCredential,
} from '../src/shared/openclawEngine/xaiAuthStore';

const runtimeRoot = process.env.OPENCLAW_STARTUP_MIGRATION_RUNTIME;
const runtimeRequire = createRequire(import.meta.url);
const profileId = 'xai:fixture';
const credential: XaiOAuthCredential = {
  type: XAI_AUTH_CREDENTIAL_TYPE, provider: XAI_AUTH_PROVIDER,
  access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 1000,
  email: 'fixture@example.invalid', displayName: 'Synthetic xAI account',
};
let directory: string;
let stateDir: string;
let owner: OpenClawXaiAuthStore;

describe.skipIf(!runtimeRoot)('bundled xAI canonical auth owner', () => {
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-xai-owner-'));
    stateDir = path.join(directory, 'state');
    owner = runtimeRequire(path.join(runtimeRoot!, OPENCLAW_XAI_AUTH_STORE_ENTRY));
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function legacySource() {
    return path.join(stateDir, 'agents/main/agent/auth-profiles.json');
  }

  function writeLegacy() {
    const source = legacySource();
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, JSON.stringify({ version: 1, profiles: { [profileId]: credential } }));
    return source;
  }

  test('reads a fresh installation without creating state and stores login in SQLite', () => {
    expect(owner.readStatus(stateDir)).toEqual({ loggedIn: false });
    expect(fs.existsSync(stateDir)).toBe(false);
    owner.replaceCredential(stateDir, profileId, credential);
    expect(owner.readStatus(stateDir)).toEqual({
      loggedIn: true, email: credential.email, displayName: credential.displayName, expiresAt: 1000,
    });
    expect(fs.existsSync(legacySource())).toBe(false);
    expect(fs.existsSync(`${legacySource()}.lock`)).toBe(false);
  });

  test('replaces the old xAI account and logout remains durable without resurrecting JSON', () => {
    owner.replaceCredential(stateDir, profileId, credential);
    owner.replaceCredential(stateDir, 'xai:replacement', { ...credential, email: 'replacement@example.invalid' });
    expect(owner.readStatus(stateDir).email).toBe('replacement@example.invalid');
    owner.logout(stateDir);
    expect(owner.readStatus(stateDir)).toEqual({ loggedIn: false });
    writeLegacy();
    expect(owner.readStatus(stateDir)).toEqual({ loggedIn: false });
  });

  test('only exposes metadata before migration and refuses credential changes until migration finishes', () => {
    const source = writeLegacy();
    const bytes = fs.readFileSync(source);
    const status = owner.readStatus(stateDir);
    expect(status).toEqual({ loggedIn: true, email: credential.email, displayName: credential.displayName, expiresAt: 1000 });
    expect(status).not.toHaveProperty('access');
    expect(status).not.toHaveProperty('refresh');
    expect(() => owner.logout(stateDir)).toThrow(expect.objectContaining({ code: XaiAuthStoreErrorCode.MigrationPending }));
    expect(() => owner.replaceCredential(stateDir, profileId, credential)).toThrow(expect.objectContaining({ code: XaiAuthStoreErrorCode.MigrationPending }));
    expect(fs.readFileSync(source)).toEqual(bytes);
  });

  test('keeps independent state roots isolated without modifying the host environment', () => {
    const environment = { ...process.env };
    const otherDir = path.join(directory, 'other-state');
    owner.replaceCredential(stateDir, profileId, credential);
    owner.replaceCredential(otherDir, profileId, { ...credential, email: 'other@example.invalid' });
    owner.logout(stateDir);
    expect(owner.readStatus(otherDir).email).toBe('other@example.invalid');
    expect(process.env).toEqual(environment);
  });

  test('observes ownership and credential changes committed by another process', () => {
    expect(owner.readStatus(stateDir)).toEqual({ loggedIn: false });
    const entry = path.join(runtimeRoot!, OPENCLAW_XAI_AUTH_STORE_ENTRY);
    execFileSync(process.execPath, ['-e', `
      const owner = require(process.argv[1]);
      owner.replaceCredential(process.argv[2], process.argv[3], JSON.parse(process.argv[4]));
    `, entry, stateDir, profileId, JSON.stringify(credential)], { stdio: 'pipe' });
    expect(owner.readStatus(stateDir).email).toBe(credential.email);
    execFileSync(process.execPath, ['-e', `
      require(process.argv[1]).logout(process.argv[2]);
    `, entry, stateDir], { stdio: 'pipe' });
    expect(owner.readStatus(stateDir)).toEqual({ loggedIn: false });
  });
});
