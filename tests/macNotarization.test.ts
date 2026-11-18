import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
const MacPackager = require('app-builder-lib/out/macPackager').default;
const { Arch } = require('builder-util');
const config = require('../electron-builder.json');
const credentials = {
  APPLE_ID: 'release@example.test',
  APPLE_APP_SPECIFIC_PASSWORD: 'test-password',
  APPLE_TEAM_ID: 'ABCDEFGHIJ',
};
const appOutDir = path.join(os.tmpdir(), 'codown notarization test', 'mac-arm64');
const appPath = path.join(appOutDir, `${config.productName}.app`);

function fixture(env: Record<string, string> = credentials) {
  const notarize = vi.fn().mockResolvedValue(undefined);
  const verifyMacWebAuthnEntitlements = vi.fn();
  const exports: { default?: (context: unknown) => Promise<void> } = {};
  const hookPath = path.resolve(__dirname, '..', config.afterSign);
  // Run the actual hook without reading local credentials or contacting Apple.
  runInNewContext(fs.readFileSync(hookPath, 'utf8'), {
    exports,
    process: { env },
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    require: (id: string) => {
      if (id === '@electron/notarize') return { notarize };
      if (id === 'dotenv') return { config: vi.fn() };
      if (id === './mac-webauthn-entitlements.cjs') return { verifyMacWebAuthnEntitlements };
      return require(id);
    },
  }, { filename: hookPath });

  const packager = Object.assign(Object.create(MacPackager.prototype), {
    info: { config: { ...config, afterSign: exports.default } },
    appInfo: { id: config.appId, productFilename: config.productName },
    platformSpecificBuildOptions: config.mac,
    computeAsarOptions: async () => ({}),
  });
  // Replace native signing only. Exercise the installed builder's built-in
  // notarization and afterSign ordering that failed in the codown release.
  packager.signApp = vi.fn(async () => {
    await packager.notarizeIfProvided(appPath, config.mac);
    return true;
  });

  return {
    notarize,
    verifyMacWebAuthnEntitlements,
    packager,
    hook: exports.default!,
    finishSigning: () => packager.doSignAfterPack(
      path.dirname(appOutDir), appOutDir, 'darwin', Arch.arm64, config.mac, [],
    ),
  };
}

beforeEach(() => {
  // release:codown forwards these from .env before electron-builder starts.
  for (const [name, value] of Object.entries(credentials)) vi.stubEnv(name, value);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('macOS release notarization', () => {
  test('notarizes exactly once through afterSign with inherited Apple credentials', async () => {
    const { finishSigning, notarize, packager, verifyMacWebAuthnEntitlements } = fixture();
    const builtInOptions = vi.spyOn(packager, 'getNotarizeOptions');

    await finishSigning();

    expect(builtInOptions).not.toHaveBeenCalled();
    expect(verifyMacWebAuthnEntitlements).toHaveBeenCalledWith(appPath);
    expect(notarize).toHaveBeenCalledTimes(1);
    expect(notarize).toHaveBeenCalledWith({
      appPath,
      appleId: credentials.APPLE_ID,
      appleIdPassword: credentials.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: credentials.APPLE_TEAM_ID,
    });
  });

  test('fails the build when the custom notarization hook fails', async () => {
    const { finishSigning, notarize } = fixture();
    const failure = new Error('Apple notarization rejected');
    notarize.mockRejectedValueOnce(failure);

    await expect(finishSigning()).rejects.toBe(failure);
    expect(notarize).toHaveBeenCalledTimes(1);
  });

  test('rejects unauthorized restricted entitlements before notarization', async () => {
    const { finishSigning, notarize, verifyMacWebAuthnEntitlements } = fixture();
    verifyMacWebAuthnEntitlements.mockImplementation(() => { throw new Error('No matching profile'); });

    await expect(finishSigning()).rejects.toThrow('No matching profile');
    expect(notarize).not.toHaveBeenCalled();
  });

  test.each(Object.keys(credentials))('keeps local builds possible without %s', async name => {
    const env: Record<string, string> = { ...credentials };
    delete env[name];
    vi.stubEnv(name, undefined);
    const { finishSigning, notarize } = fixture(env);

    await finishSigning();

    expect(notarize).not.toHaveBeenCalled();
  });

  test('does not notarize Windows builds', async () => {
    const { hook, notarize } = fixture();

    await hook({ electronPlatformName: 'win32' });

    expect(notarize).not.toHaveBeenCalled();
  });
});
