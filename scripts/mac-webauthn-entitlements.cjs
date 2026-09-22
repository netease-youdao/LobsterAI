'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// APPLE_TEAM_ID is already supplied by the macOS release workflow. Only the
// main executable gets this keychain group; helpers keep their existing rights.
function configureMacWebAuthnEntitlements(config, teamId, platform = process.platform) {
  if (platform !== 'darwin' || !teamId) return;
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('Invalid APPLE_TEAM_ID for WebAuthn entitlements.');
  const source = fs.readFileSync(path.resolve(__dirname, '..', config.mac.entitlements), 'utf8');
  const group = `${teamId}.${config.appId}.webauthn`;
  const entitlements = source.replace('</dict>', `    <key>keychain-access-groups</key>\n    <array><string>${group}</string></array>\n</dict>`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-webauthn-entitlements-'));
  config.mac.entitlements = path.join(directory, 'entitlements.plist');
  fs.writeFileSync(config.mac.entitlements, entitlements);
}

module.exports = { configureMacWebAuthnEntitlements };
