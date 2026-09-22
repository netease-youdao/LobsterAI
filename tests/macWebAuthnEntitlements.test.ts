import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, systemPreferences: {} }));
import { readWebAuthnKeychainGroup } from '../src/main/browserPasskeys/macWebAuthn';

const { configureMacWebAuthnEntitlements } = require('../scripts/mac-webauthn-entitlements.cjs');

describe('macOS WebAuthn packaging', () => {
  test('signs the same keychain group the runtime reads, without granting it to helpers', () => {
    const config = {
      appId: 'com.lobsterai.app',
      mac: { entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist' },
    };
    configureMacWebAuthnEntitlements(config, 'ABCDEFGHIJ', 'darwin');
    try {
      const plist = fs.readFileSync(config.mac.entitlements, 'utf8');
      expect(readWebAuthnKeychainGroup(plist)).toBe('ABCDEFGHIJ.com.lobsterai.app.webauthn');
      expect(plist).toContain('<key>com.apple.security.cs.allow-jit</key>');
      expect(config.mac.entitlementsInherit).toBe('build/entitlements.mac.plist');
    } finally {
      fs.rmSync(path.dirname(config.mac.entitlements), { recursive: true, force: true });
    }
  });

  test('does not advertise an unsigned or unrelated keychain group', () => {
    expect(readWebAuthnKeychainGroup('<dict/>')).toBeUndefined();
    expect(readWebAuthnKeychainGroup('<key>keychain-access-groups</key><array><string>ABCDEFGHIJ.other.app</string></array>')).toBeUndefined();
    const config = { mac: { entitlements: 'build/entitlements.mac.plist' } };
    configureMacWebAuthnEntitlements(config, undefined, 'darwin');
    configureMacWebAuthnEntitlements(config, 'ABCDEFGHIJ', 'win32');
    expect(config.mac.entitlements).toBe('build/entitlements.mac.plist');
    expect(() => configureMacWebAuthnEntitlements(config, '<invalid>', 'darwin')).toThrow();
  });
});
