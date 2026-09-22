import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  configure: vi.fn(),
  canPrompt: vi.fn(),
  app: { isPackaged: true },
}));
vi.mock('node:util', () => ({ promisify: () => mocks.execFile }));
vi.mock('electron', () => ({
  app: { get isPackaged() { return mocks.app.isPackaged; }, configureWebAuthn: mocks.configure },
  systemPreferences: { canPromptTouchID: mocks.canPrompt },
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  mocks.app.isPackaged = true;
  mocks.canPrompt.mockReturnValue(true);
  mocks.execFile.mockResolvedValue({ stdout: '<key>keychain-access-groups</key><array><string>ABCDEFGHIJ.com.lobsterai.app.webauthn</string></array>' });
});
afterEach(() => { Object.defineProperty(process, 'platform', platformDescriptor); });

describe('macOS native passkey initialization', () => {
  test('configures once using only the entitlement in the executable signature', async () => {
    const { configureMacWebAuthn } = await import('./macWebAuthn');
    expect(await configureMacWebAuthn()).toBe(true);
    expect(await configureMacWebAuthn()).toBe(true);
    expect(mocks.configure).toHaveBeenCalledExactlyOnceWith({ touchID: { keychainAccessGroup: 'ABCDEFGHIJ.com.lobsterai.app.webauthn' } });
    expect(mocks.execFile).toHaveBeenCalledOnce();
  });

  test('leaves unsigned development builds and missing entitlements unavailable', async () => {
    mocks.app.isPackaged = false;
    const { configureMacWebAuthn } = await import('./macWebAuthn');
    expect(await configureMacWebAuthn()).toBe(false);
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.configure).not.toHaveBeenCalled();
    vi.resetModules();
    mocks.app.isPackaged = true;
    mocks.execFile.mockResolvedValue({ stdout: '<dict/>' });
    const fresh = await import('./macWebAuthn');
    expect(await fresh.configureMacWebAuthn()).toBe(false);
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  test('a hardware capability error does not prevent the browser from opening', async () => {
    mocks.canPrompt.mockImplementationOnce(() => { throw new Error('biometrics unavailable'); });
    const { configureMacWebAuthn } = await import('./macWebAuthn');
    expect(await configureMacWebAuthn()).toBe(false);
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  test('does not change Windows or Linux native authenticator configuration', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { configureMacWebAuthn } = await import('./macWebAuthn');
    expect(await configureMacWebAuthn()).toBeUndefined();
    expect(mocks.configure).not.toHaveBeenCalled();
  });
});
