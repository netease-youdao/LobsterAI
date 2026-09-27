import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { app, systemPreferences } from 'electron';

const execFileAsync = promisify(execFile);
const KEYCHAIN_GROUP_PATTERN = /^[A-Z0-9]{10}\.com\.lobsterai\.app\.webauthn$/;

export const readWebAuthnKeychainGroup = (entitlements: string): string | undefined => {
  const groups = entitlements.match(/<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
  if (!groups) return undefined;
  return Array.from(groups.matchAll(/<string>([^<]+)<\/string>/g), match => match[1])
    .find(group => KEYCHAIN_GROUP_PATTERN.test(group));
};

let initialization: Promise<boolean | undefined> | undefined;

export const configureMacWebAuthn = (): Promise<boolean | undefined> => {
  // Windows delegates to the OS. Availability depends on the user's hardware
  // and enrolled authenticators; don't claim to have probed it here.
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  initialization ??= (async () => {
    try {
      if (!app.isPackaged || !systemPreferences.canPromptTouchID()) return false;
      // Read the effective signature, rather than trusting an environment
      // variable or a plist whose entitlement may not have been signed.
      const { stdout } = await execFileAsync('/usr/bin/codesign', [
        '--display', '--entitlements', ':-', process.execPath,
      ], { timeout: 5_000, maxBuffer: 128 * 1024 });
      const keychainAccessGroup = readWebAuthnKeychainGroup(stdout);
      if (!keychainAccessGroup) return false;
      app.configureWebAuthn({ touchID: { keychainAccessGroup } });
      console.log('[BrowserPasskeys] Touch ID authenticator configured.');
      return true;
    } catch (error) {
      console.warn('[BrowserPasskeys] Touch ID authenticator unavailable:', error);
      return false;
    }
  })();
  return initialization;
};
