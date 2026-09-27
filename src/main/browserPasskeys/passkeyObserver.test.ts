import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';

import { describe, expect, test, vi } from 'vitest';

import {
  BrowserCredentialMediation,
  BrowserCredentialMethod,
  BrowserPasskeyStatus,
} from '../../shared/browserWebAccess/passkeys';
import { installPasskeyObserver } from './passkeyObserver';

const setup = (original = vi.fn()) => {
  const report = vi.fn();
  let cancel: (id: string) => void = () => {};
  const context = {
    original, report,
    onCancel: (callback: typeof cancel) => { cancel = callback; },
    crypto: { randomUUID }, AbortController, AbortSignal,
    constants: { status: BrowserPasskeyStatus, method: BrowserCredentialMethod, mediation: BrowserCredentialMediation },
  };
  const container = runInNewContext(`
    class PublicKeyCredential {}
    class CredentialsContainer {
      get(options) { return original.call(this, options); }
      create(options) { return original.call(this, options); }
    }
    globalThis.PublicKeyCredential = PublicKeyCredential;
    globalThis.CredentialsContainer = CredentialsContainer;
    (${installPasskeyObserver.toString()})(constants, report, onCancel);
    new CredentialsContainer();
  `, context) as CredentialsContainer;
  return { container, original, report, cancel: (id: string) => cancel(id) };
};

describe('passkey observer', () => {
  test('keeps the native credential, binary response, options and receiver intact', async () => {
    const credential = { rawId: new ArrayBuffer(16), response: { signature: new ArrayBuffer(32) } };
    const original = vi.fn().mockResolvedValue(credential);
    const { container, report } = setup(original);
    const publicKey = { challenge: new Uint8Array([1, 2, 3]) };
    const result = await container.get({ publicKey });
    expect(result).toBe(credential);
    expect(original.mock.contexts[0]).toBe(container);
    expect(original.mock.calls[0][0].publicKey).toBe(publicKey);
    expect(report.mock.calls.map(([event]) => event.status)).toEqual([
      BrowserPasskeyStatus.Waiting, BrowserPasskeyStatus.Succeeded,
    ]);
    expect(Object.keys(report.mock.calls[0][0]).sort()).toEqual(['requestId', 'status']);
  });

  test('leaves conditional autofill and non-public-key credentials silent and untouched', async () => {
    const result = Promise.resolve(null);
    const { container, original, report } = setup(vi.fn().mockReturnValue(result));
    const options = { mediation: BrowserCredentialMediation.Conditional, publicKey: { challenge: new Uint8Array(1) } };
    expect(container.get(options)).toBe(result);
    expect(original.mock.calls[0][0]).toBe(options);
    expect(container.get()).toBe(result);
    expect(report).not.toHaveBeenCalled();
  });

  test('cancels only the requested operation and preserves page AbortSignals', async () => {
    const original = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }));
    const { container, report, cancel } = setup(original);
    const first = container.get({ publicKey: { challenge: new Uint8Array(1) } });
    const pageController = new AbortController();
    const second = container.get({ publicKey: { challenge: new Uint8Array(1) }, signal: pageController.signal });
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    cancel(report.mock.calls[0][0].requestId);
    await firstRejected;
    expect(original.mock.calls[1][0].signal.aborted).toBe(false);
    const reason = new Error('page cancelled');
    const secondRejected = expect(second).rejects.toBe(reason);
    pageController.abort(reason);
    await secondRejected;
    expect(report.mock.calls.at(-1)?.[0].status).toBe(BrowserPasskeyStatus.Cancelled);
  });

  test('observes registration and preserves native failures without substituting an error', async () => {
    const nativeError = new DOMException('No matching credential', 'NotAllowedError');
    const { container, report } = setup(vi.fn().mockRejectedValue(nativeError));
    await expect(container.create({ publicKey: {} as PublicKeyCredentialCreationOptions })).rejects.toBe(nativeError);
    expect(report.mock.calls.at(-1)?.[0].status).toBe(BrowserPasskeyStatus.Failed);
  });
});
