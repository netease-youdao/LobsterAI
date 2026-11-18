import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, systemPreferences: {} }));
import { readWebAuthnKeychainGroup } from '../src/main/browserPasskeys/macWebAuthn';

const require = createRequire(import.meta.url);
const plist = require('plist');
const { MacSigningEnv, MacEntitlement, webAuthnEntitlementsForProfile, configureMacWebAuthnEntitlements } = require('../scripts/mac-webauthn-entitlements.cjs');
const { packagingEnv } = require('../scripts/codown-config.cjs');
const scriptPath = path.resolve(__dirname, '../scripts/mac-webauthn-entitlements.cjs');
const teamId = 'ABCDEFGHIJ';
const appId = 'com.lobsterai.app';
const certificate = Buffer.from('fixture signing certificate');
const roots: string[] = [];

function temporary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webauthn-packaging-test-'));
  roots.push(root);
  return root;
}

function config() {
  return {
    appId,
    mac: { entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist' },
  };
}

function profile(prefix = teamId) {
  return {
    Platform: ['OSX'],
    ProvisionsAllDevices: true,
    ExpirationDate: new Date('2099-01-01T00:00:00Z'),
    TeamIdentifier: [teamId],
    ApplicationIdentifierPrefix: [prefix],
    DeveloperCertificates: [certificate],
    Entitlements: {
      [MacEntitlement.TeamId]: teamId,
      [MacEntitlement.ApplicationId]: `${prefix}.${appId}`,
      [MacEntitlement.KeychainGroups]: [`${prefix}.*`],
    },
  };
}

function fixture(signed: Record<string, unknown> = {}, authorization = profile()) {
  const command = vi.fn((binary: string, args: string[]) => {
    if (binary === '/usr/bin/security') return plist.build(authorization);
    if (args.includes('--entitlements')) return plist.build(signed);
    if (args.includes('--extract-certificates')) {
      fs.writeFileSync(`${args[2]}0`, certificate);
      return '';
    }
    throw new Error(`Unexpected command: ${binary} ${args.join(' ')}`);
  });
  const module = { exports: {} as {
    configureMacWebAuthnEntitlements: typeof configureMacWebAuthnEntitlements;
    verifyMacWebAuthnEntitlements: (appPath: string) => void;
  } };
  runInNewContext(fs.readFileSync(scriptPath, 'utf8'), {
    module, __dirname: path.dirname(scriptPath), process, Buffer,
    require: (id: string) => id === 'node:child_process' ? { execFileSync: command } : require(id),
  }, { filename: scriptPath });
  const appPath = path.join(temporary(), 'LobsterAI.app');
  const contents = path.join(appPath, 'Contents');
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist.build({ CFBundleIdentifier: appId }));
  const profileFile = path.join(contents, 'embedded.provisionprofile');
  fs.writeFileSync(profileFile, 'CMS fixture decoded by the mocked security command');
  return { ...module.exports, command, appPath, profileFile };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('macOS WebAuthn packaging', () => {
  test('keeps direct and codown builds launchable when .env only supplies notarization credentials', () => {
    const root = temporary();
    fs.writeFileSync(path.join(root, '.env'), `${MacSigningEnv.TeamId}=${teamId}\n`);
    const direct = config();
    const codown = config();
    configureMacWebAuthnEntitlements(direct, packagingEnv(root, {}), 'darwin');
    configureMacWebAuthnEntitlements(codown, packagingEnv(root, { [MacSigningEnv.TeamId]: teamId }), 'darwin');
    expect(direct).toEqual(config());
    expect(codown).toEqual(config());
    expect(readWebAuthnKeychainGroup(fs.readFileSync(direct.mac.entitlements, 'utf8'))).toBeUndefined();
  });

  test('embeds the explicit profile and grants authorized rights only to the main executable', () => {
    const f = fixture();
    const build = config();
    f.configureMacWebAuthnEntitlements(build, {
      [MacSigningEnv.TeamId]: teamId,
      [MacSigningEnv.ProvisioningProfile]: f.profileFile,
    }, 'darwin');
    roots.push(path.dirname(build.mac.entitlements));
    const xml = fs.readFileSync(build.mac.entitlements, 'utf8');
    expect(readWebAuthnKeychainGroup(xml)).toBe(`${teamId}.${appId}.webauthn`);
    expect(plist.parse(xml)).toMatchObject({
      ...webAuthnEntitlementsForProfile(profile(), appId, teamId),
      'com.apple.security.cs.allow-jit': true,
    });
    expect(build.mac).toMatchObject({
      provisioningProfile: f.profileFile,
      entitlementsInherit: 'build/entitlements.mac.plist',
    });
  });

  test('accepts explicit keychain groups and a legacy App ID prefix different from the team', () => {
    const authorization = profile('ZYXWVUTSRQ');
    const group = `ZYXWVUTSRQ.${appId}.webauthn`;
    authorization.Entitlements[MacEntitlement.KeychainGroups] = [group];
    const rights = webAuthnEntitlementsForProfile(authorization, appId, teamId);
    expect(rights[MacEntitlement.KeychainGroups]).toEqual([group]);
    expect(rights[MacEntitlement.TeamId]).toBe(teamId);
    expect(readWebAuthnKeychainGroup(plist.build(rights))).toBe(group);
  });

  test.each([
    ['wrong team', { TeamIdentifier: ['ZYXWVUTSRQ'] }],
    ['wrong platform', { Platform: ['iOS'] }],
    ['App Store profile', { ProvisionsAllDevices: false }],
    ['device-limited profile', { ProvisionedDevices: ['test-device'] }],
    ['expired profile', { ExpirationDate: new Date('2000-01-01') }],
    ['missing expiration', { ExpirationDate: undefined }],
  ] as const)('rejects %s before signing', (_name, overrides) => {
    expect(() => webAuthnEntitlementsForProfile({ ...profile(), ...overrides }, appId, teamId)).toThrow();
  });

  test('rejects a different app, an unauthorized keychain group, and a mismatched notarization team', () => {
    expect(() => webAuthnEntitlementsForProfile(profile(), 'com.other.app', teamId)).toThrow('does not authorize');
    expect(() => webAuthnEntitlementsForProfile(profile(), appId, 'ZYXWVUTSRQ')).toThrow('APPLE_TEAM_ID');
    const authorization = profile();
    authorization.Entitlements[MacEntitlement.KeychainGroups] = [`${teamId}.other.*`];
    expect(() => webAuthnEntitlementsForProfile(authorization, appId, teamId)).toThrow('keychain group');
  });

  test('ignores macOS provisioning options on other platforms', () => {
    const build = config();
    configureMacWebAuthnEntitlements(build, { [MacSigningEnv.ProvisioningProfile]: '/missing/profile' }, 'win32');
    expect(build).toEqual(config());
  });

  test('fails closed when an explicitly configured profile cannot be decoded', () => {
    const f = fixture();
    f.command.mockImplementation(() => { throw new Error('invalid CMS profile'); });
    const build = config();
    expect(() => f.configureMacWebAuthnEntitlements(build, {
      [MacSigningEnv.ProvisioningProfile]: f.profileFile,
    }, 'darwin')).toThrow('invalid CMS profile');
    expect(build).toEqual(config());
  });

  test('rejects the reported signed-but-unprovisioned app even when codesign verification could pass', () => {
    const f = fixture({ [MacEntitlement.KeychainGroups]: [`${teamId}.${appId}.webauthn`] });
    fs.unlinkSync(f.profileFile);
    expect(() => f.verifyMacWebAuthnEntitlements(f.appPath)).toThrow('macOS would reject launch');
  });

  test('does not allow an empty restricted entitlement to bypass provisioning checks', () => {
    const f = fixture({ [MacEntitlement.KeychainGroups]: [] });
    fs.unlinkSync(f.profileFile);
    expect(() => f.verifyMacWebAuthnEntitlements(f.appPath)).toThrow('macOS would reject launch');
  });

  test('allows profile-free apps without restricted keychain rights', () => {
    const f = fixture();
    fs.unlinkSync(f.profileFile);
    expect(() => f.verifyMacWebAuthnEntitlements(f.appPath)).not.toThrow();
    expect(f.command).toHaveBeenCalledTimes(1);
  });

  test('checks the signed entitlements and actual signing certificate against the embedded profile', () => {
    const rights = webAuthnEntitlementsForProfile(profile(), appId, teamId);
    const good = fixture(rights);
    expect(() => good.verifyMacWebAuthnEntitlements(good.appPath)).not.toThrow();
    const wrongId = fixture({ ...rights, [MacEntitlement.ApplicationId]: `${teamId}.other.app` });
    expect(() => wrongId.verifyMacWebAuthnEntitlements(wrongId.appPath)).toThrow('Signed entitlements');
    const wrongGroup = fixture({ ...rights, [MacEntitlement.KeychainGroups]: ['ZYXWVUTSRQ.other'] });
    expect(() => wrongGroup.verifyMacWebAuthnEntitlements(wrongGroup.appPath)).toThrow('Signed entitlements');
    const wrongCertificate = fixture(rights, { ...profile(), DeveloperCertificates: [Buffer.from('other certificate')] });
    expect(() => wrongCertificate.verifyMacWebAuthnEntitlements(wrongCertificate.appPath)).toThrow('Signing certificate');
  });
});
