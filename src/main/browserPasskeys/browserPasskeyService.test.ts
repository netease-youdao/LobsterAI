import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configure: vi.fn().mockResolvedValue(false),
  showMessageBox: vi.fn(),
}));
vi.mock('electron', () => ({ dialog: { showMessageBox: mocks.showMessageBox } }));
vi.mock('./macWebAuthn', () => ({ configureMacWebAuthn: mocks.configure }));

import {
  BrowserPasskeyAction,
  BrowserPasskeyChannel,
  BrowserPasskeyStatus,
} from '../../shared/browserWebAccess/passkeys';
import { BrowserPasskeyService } from './browserPasskeyService';

const setup = () => {
  const session = new EventEmitter();
  const frame = { top: undefined as unknown, isDestroyed: () => false };
  frame.top = frame;
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    getURL: () => 'https://example.com/login?secret=not-for-the-ui',
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const webContents = contents as unknown as Electron.WebContents;
  const changed = vi.fn();
  const service = new BrowserPasskeyService({
    session: session as Electron.Session,
    getMainWindow: () => ({ isDestroyed: () => false }) as Electron.BrowserWindow,
    onChanged: changed,
  });
  service.watch(webContents, 1);
  const report = (requestId: string, status: BrowserPasskeyStatus) => contents.emit(
    'ipc-message', { senderFrame: frame }, BrowserPasskeyChannel.Event, { requestId, status },
  );
  return { session, service, frame, contents, webContents, report, changed };
};

beforeEach(() => { vi.clearAllMocks(); });

describe('browser passkey lifecycle', () => {
  test('isolates request identity and rejects subframe status messages', async () => {
    const { service, webContents, contents, report } = setup();
    await service.ready;
    contents.emit('ipc-message', { senderFrame: {} }, BrowserPasskeyChannel.Event, {
      requestId: 'spoof', status: BrowserPasskeyStatus.Waiting,
    });
    expect(service.getNotice(webContents)).toBeUndefined();
    report('old', BrowserPasskeyStatus.Waiting);
    report('new', BrowserPasskeyStatus.Waiting);
    report('old', BrowserPasskeyStatus.Succeeded);
    expect(service.getNotice(webContents)).toMatchObject({
      requestId: 'new', origin: 'https://example.com', platformAuthenticatorAvailable: false,
    });
    service.resolve(webContents, { pageId: 1, requestId: 'old', action: BrowserPasskeyAction.Cancel });
    expect(contents.send).not.toHaveBeenCalled();
    service.resolve(webContents, { pageId: 2, requestId: 'new', action: BrowserPasskeyAction.Cancel });
    expect(contents.send).not.toHaveBeenCalled();
    service.resolve(webContents, { pageId: 1, requestId: 'new', action: BrowserPasskeyAction.Cancel });
    expect(contents.send).toHaveBeenCalledWith(BrowserPasskeyChannel.Cancel, 'new');
    expect(service.getNotice(webContents)?.status).toBe(BrowserPasskeyStatus.Cancelled);
    service.dispose();
  });

  test('clears successful and navigated requests and ignores late completion', () => {
    const { service, webContents, contents, report } = setup();
    report('one', BrowserPasskeyStatus.Waiting);
    report('one', BrowserPasskeyStatus.Succeeded);
    expect(service.getNotice(webContents)).toBeUndefined();
    report('two', BrowserPasskeyStatus.Waiting);
    contents.emit('did-start-navigation', {}, 'https://other.example', false, true);
    expect(contents.send).toHaveBeenCalledWith(BrowserPasskeyChannel.Cancel, 'two');
    report('two', BrowserPasskeyStatus.Failed);
    expect(service.getNotice(webContents)).toBeUndefined();
    service.dispose();
  });

  test('dismissal aborts a pending request without allowing its rejection to restore the banner', () => {
    const { service, webContents, contents, report } = setup();
    report('one', BrowserPasskeyStatus.Waiting);
    service.resolve(webContents, { pageId: 1, requestId: 'one', action: BrowserPasskeyAction.Dismiss });
    report('one', BrowserPasskeyStatus.Cancelled);
    expect(contents.send).toHaveBeenCalledWith(BrowserPasskeyChannel.Cancel, 'one');
    expect(service.getNotice(webContents)).toBeUndefined();
    service.dispose();
  });

  test('native account selection requires the user to choose and returns only that credential', async () => {
    const { session, service, frame } = setup();
    const callback = vi.fn();
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    session.emit('select-webauthn-account', {}, {
      frame, relyingPartyId: 'example.com',
      accounts: [{ credentialId: 'first-secret', name: 'First' }, { credentialId: 'second-secret', name: 'Second' }],
    }, callback);
    await new Promise(resolve => setImmediate(resolve));
    expect(callback).toHaveBeenCalledExactlyOnceWith('second-secret');
    expect(mocks.showMessageBox.mock.calls[0][1]).toMatchObject({ defaultId: 2, cancelId: 2 });
    service.dispose();
  });

  test('cancels native account selection when its initiating frame has already gone away', () => {
    const { session, service } = setup();
    const callback = vi.fn();
    session.emit('select-webauthn-account', {}, {
      frame: { isDestroyed: () => true }, relyingPartyId: 'example.com',
      accounts: [{ credentialId: 'secret', name: 'Account' }],
    }, callback);
    expect(callback).toHaveBeenCalledOnce();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    service.dispose();
  });

  test('always settles native requests when selection throws or the page navigates', async () => {
    const { session, service, frame, contents } = setup();
    const details = { frame, relyingPartyId: 'example.com', accounts: [{ credentialId: 'secret', name: 'Account' }] };
    mocks.showMessageBox.mockImplementationOnce(() => { throw new Error('dialog unavailable'); });
    const callback = vi.fn();
    session.emit('select-webauthn-account', {}, details, callback);
    await new Promise(resolve => setImmediate(resolve));
    expect(callback).toHaveBeenCalledExactlyOnceWith(undefined);
    let finish: (result: { response: number }) => void = () => {};
    mocks.showMessageBox.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const cancelled = vi.fn();
    session.emit('select-webauthn-account', {}, details, cancelled);
    contents.emit('did-start-navigation', {}, 'https://other.example', false, true);
    finish({ response: 0 });
    await new Promise(resolve => setImmediate(resolve));
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(undefined);
    service.dispose();
  });
});
