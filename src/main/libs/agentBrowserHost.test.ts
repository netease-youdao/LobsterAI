import { beforeEach, describe, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  flushStorageData: vi.fn(),
  flushStore: vi.fn<() => Promise<void>>(),
  fromPartition: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
  setPermissionRequestHandler: vi.fn(),
  setProxy: vi.fn<() => Promise<void>>(),
}));

vi.mock('electron', () => ({
  session: {
    fromPartition: electronMocks.fromPartition,
  },
  WebContentsView: class {},
}));

import {
  type BrowserCredentialLoginState,
  BrowserCredentialLoginStatus,
} from '../../shared/browserCredentials/constants';
import { AgentBrowserPartition } from '../../shared/browserWebAccess/constants';
import { AgentBrowserHost } from './agentBrowserHost';

const createHost = (): AgentBrowserHost => new AgentBrowserHost({
  getMainWindow: () => null,
  getBrowserConfig: () => undefined,
  useSystemProxy: () => false,
  emitState: vi.fn(),
  credentialService: {} as never,
  credentialApprovalService: {} as never,
  resolveSessionKey: () => undefined,
});

describe('AgentBrowserHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.flushStore.mockResolvedValue();
    electronMocks.setProxy.mockResolvedValue();
    electronMocks.fromPartition.mockReturnValue({
      cookies: {
        flushStore: electronMocks.flushStore,
      },
      flushStorageData: electronMocks.flushStorageData,
      setPermissionCheckHandler: electronMocks.setPermissionCheckHandler,
      setPermissionRequestHandler: electronMocks.setPermissionRequestHandler,
      setProxy: electronMocks.setProxy,
    });
  });

  test('uses a persistent Electron partition for in-app pages', () => {
    createHost();

    expect(electronMocks.fromPartition).toHaveBeenCalledWith(
      AgentBrowserPartition.Default,
      { cache: true },
    );
    expect(AgentBrowserPartition.Default).toMatch(/^persist:/);
  });

  test('flushes cookies and DOM storage before shutdown completes', async () => {
    let finishCookieFlush: (() => void) | undefined;
    electronMocks.flushStore.mockReturnValue(new Promise(resolve => {
      finishCookieFlush = resolve;
    }));
    const host = createHost();

    let disposed = false;
    const disposePromise = host.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>(resolve => { setImmediate(resolve); });

    expect(electronMocks.flushStorageData).toHaveBeenCalledOnce();
    expect(electronMocks.flushStore).toHaveBeenCalledOnce();
    expect(disposed).toBe(false);

    finishCookieFlush?.();
    await disposePromise;

    expect(disposed).toBe(true);
  });

  test('dismisses a completed saved-credential login status', () => {
    const host = createHost();
    const hostState = host as unknown as {
      credentialLoginState?: BrowserCredentialLoginState;
    };
    hostState.credentialLoginState = {
      status: BrowserCredentialLoginStatus.Failed,
      origin: 'https://example.com',
    };

    expect(host.getState().credentialLogin).toBeDefined();

    const state = host.dismissCredentialLoginStatus();

    expect(state.credentialLogin).toBeUndefined();
    expect(host.getState().credentialLogin).toBeUndefined();
  });
});
