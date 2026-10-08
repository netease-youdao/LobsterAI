import Database from 'better-sqlite3';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  BrowserCredentialAvailabilityReason,
  BrowserCredentialIpc,
} from '../../../shared/browserCredentials/constants';
import { BrowserCredentialService } from '../../browserCredentials/browserCredentialService';
import { registerBrowserCredentialHandlers } from './handlers';

describe('browser credential IPC access', () => {
  let db: Database.Database;
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let probe: ReturnType<typeof vi.fn<() => boolean>>;

  beforeEach(() => {
    db = new Database(':memory:');
    handlers = new Map();
    probe = vi.fn(() => true);
    const service = new BrowserCredentialService(db, {
      isEncryptionAvailable: probe,
      getSelectedStorageBackend: () => 'kwallet6',
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString(),
    }, 'darwin');
    registerBrowserCredentialHandlers({
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) } as IpcMain,
      getService: () => service,
    });
  });

  afterEach(() => { db.close(); });

  test('mount requests are passive while the explicit access IPC invokes OS authorization', () => {
    expect(handlers.get(BrowserCredentialIpc.GetAvailability)!()).toEqual({
      success: true,
      availability: { available: false, reason: BrowserCredentialAvailabilityReason.AccessNotRequested },
    });
    expect(handlers.get(BrowserCredentialIpc.List)!()).toEqual({ success: true, credentials: [] });
    expect(probe).not.toHaveBeenCalled();

    expect(handlers.get(BrowserCredentialIpc.RequestAccess)!()).toEqual({
      success: true,
      availability: { available: true },
    });
    handlers.get(BrowserCredentialIpc.GetAvailability)!();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test('returns recoverable macOS denial state without treating denial as a transport error', () => {
    probe.mockReturnValue(false);
    const response = {
      success: true,
      availability: {
        available: false,
        reason: BrowserCredentialAvailabilityReason.EncryptionUnavailable,
        requiresRestart: true,
      },
    };
    expect(handlers.get(BrowserCredentialIpc.RequestAccess)!()).toEqual(response);
    expect(handlers.get(BrowserCredentialIpc.GetAvailability)!()).toEqual(response);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
