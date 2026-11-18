'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const plist = require('plist');

const MacSigningEnv = {
  TeamId: 'APPLE_TEAM_ID',
  ProvisioningProfile: 'APPLE_PROVISIONING_PROFILE',
};
const MacEntitlement = {
  KeychainGroups: 'keychain-access-groups',
  ApplicationId: 'com.apple.application-identifier',
  TeamId: 'com.apple.developer.team-identifier',
};
const commandOptions = { encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 };

function allowsIdentifier(pattern, identifier) {
  return typeof pattern === 'string' && (pattern === identifier
    || (pattern.endsWith('.*') && identifier.startsWith(pattern.slice(0, -1))));
}

function readProfile(file) {
  return plist.parse(execFileSync('/usr/bin/security', ['cms', '-D', '-i', file], commandOptions));
}

function webAuthnEntitlementsForProfile(profile, appId, teamId, now = Date.now()) {
  const rights = profile.Entitlements || {};
  const profileTeam = rights[MacEntitlement.TeamId];
  if (!/^[A-Z0-9]{10}$/.test(profileTeam || '') || !profile.TeamIdentifier?.includes(profileTeam)
    || (teamId && profileTeam !== teamId)) {
    throw new Error('[MacWebAuthn] Provisioning profile does not match APPLE_TEAM_ID.');
  }
  if (!profile.Platform?.includes('OSX') || profile.ProvisionsAllDevices !== true
    || profile.ProvisionedDevices || rights['com.apple.security.get-task-allow'] === true) {
    throw new Error('[MacWebAuthn] A Developer ID macOS distribution provisioning profile is required.');
  }
  if (!(new Date(profile.ExpirationDate).getTime() > now)) {
    throw new Error('[MacWebAuthn] Provisioning profile is expired or has no valid expiration date.');
  }
  // Older developer accounts can have an App ID prefix different from their
  // Team ID. The profile, not the notarization credentials, owns that prefix.
  const prefix = profile.ApplicationIdentifierPrefix?.find(candidate =>
    /^[A-Z0-9]{10}$/.test(candidate)
      && allowsIdentifier(rights[MacEntitlement.ApplicationId], `${candidate}.${appId}`));
  if (!prefix) throw new Error(`[MacWebAuthn] Provisioning profile does not authorize ${appId}.`);
  const applicationId = `${prefix}.${appId}`;
  const group = `${applicationId}.webauthn`;
  if (!Array.isArray(rights[MacEntitlement.KeychainGroups])
    || !rights[MacEntitlement.KeychainGroups].some(pattern => allowsIdentifier(pattern, group))) {
    throw new Error(`[MacWebAuthn] Provisioning profile does not authorize keychain group ${group}.`);
  }
  return {
    [MacEntitlement.ApplicationId]: applicationId,
    [MacEntitlement.TeamId]: profileTeam,
    [MacEntitlement.KeychainGroups]: [group],
  };
}

function configureMacWebAuthnEntitlements(config, env = process.env, platform = process.platform) {
  if (platform !== 'darwin') return;
  const profileFile = env[MacSigningEnv.ProvisioningProfile]?.trim() || config.mac.provisioningProfile;
  // A notarization Team ID does not authorize restricted entitlements. Without
  // a profile the runtime already leaves the optional Touch ID authenticator off.
  if (!profileFile) return;
  const profilePath = path.resolve(__dirname, '..', profileFile);
  const rights = webAuthnEntitlementsForProfile(readProfile(profilePath), config.appId, env[MacSigningEnv.TeamId]);
  const source = plist.parse(fs.readFileSync(path.resolve(__dirname, '..', config.mac.entitlements), 'utf8'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-webauthn-entitlements-'));
  config.mac.entitlements = path.join(directory, 'entitlements.plist');
  fs.writeFileSync(config.mac.entitlements, plist.build({ ...source, ...rights }));
  // electron-builder / @electron/osx-sign embeds this before signing. Helpers
  // continue to use entitlementsInherit without the restricted rights.
  config.mac.provisioningProfile = profilePath;
}

function verifyMacWebAuthnEntitlements(appPath) {
  const signed = plist.parse(execFileSync('/usr/bin/codesign', [
    '--display', '--entitlements', ':-', appPath,
  ], { ...commandOptions, stdio: ['ignore', 'pipe', 'pipe'] }));
  const groups = signed[MacEntitlement.KeychainGroups];
  if (!(MacEntitlement.KeychainGroups in signed)) return;
  const profileFile = path.join(appPath, 'Contents', 'embedded.provisionprofile');
  if (!fs.existsSync(profileFile)) {
    throw new Error('[MacWebAuthn] Signed keychain-access-groups requires Contents/embedded.provisionprofile; macOS would reject launch.');
  }
  const profile = readProfile(profileFile);
  const info = plist.parse(fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8'));
  const expected = webAuthnEntitlementsForProfile(profile, info.CFBundleIdentifier, signed[MacEntitlement.TeamId]);
  if (signed[MacEntitlement.ApplicationId] !== expected[MacEntitlement.ApplicationId]
    || signed[MacEntitlement.TeamId] !== expected[MacEntitlement.TeamId]
    || !Array.isArray(groups) || !groups.every(group => typeof group === 'string' && !group.includes('*')
      && profile.Entitlements[MacEntitlement.KeychainGroups].some(pattern => allowsIdentifier(pattern, group)))) {
    throw new Error('[MacWebAuthn] Signed entitlements do not match the embedded provisioning profile.');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-webauthn-certificate-'));
  try {
    const prefix = path.join(directory, 'certificate');
    execFileSync('/usr/bin/codesign', ['--display', '--extract-certificates', prefix, appPath], commandOptions);
    const certificate = fs.readFileSync(`${prefix}0`);
    if (!profile.DeveloperCertificates?.some(allowed => Buffer.isBuffer(allowed) && allowed.equals(certificate))) {
      throw new Error('[MacWebAuthn] Signing certificate is not authorized by the embedded provisioning profile.');
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { MacSigningEnv, MacEntitlement, webAuthnEntitlementsForProfile, configureMacWebAuthnEntitlements, verifyMacWebAuthnEntitlements };
