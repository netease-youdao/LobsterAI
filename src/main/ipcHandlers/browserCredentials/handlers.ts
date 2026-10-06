import type { IpcMain } from 'electron';

import {
  type BrowserCredentialAvailabilityResponse,
  type BrowserCredentialDeleteRequest,
  BrowserCredentialIpc,
  type BrowserCredentialListResponse,
  type BrowserCredentialMutationResponse,
  type BrowserCredentialSaveRequest,
} from '../../../shared/browserCredentials/constants';
import type { BrowserCredentialService } from '../../browserCredentials/browserCredentialService';

export interface BrowserCredentialHandlerDeps {
  ipcMain: IpcMain;
  getService: () => BrowserCredentialService;
}

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : 'Browser credential operation failed.'
);

export const registerBrowserCredentialHandlers = ({
  ipcMain,
  getService,
}: BrowserCredentialHandlerDeps): void => {
  ipcMain.handle(
    BrowserCredentialIpc.GetAvailability,
    (): BrowserCredentialAvailabilityResponse => {
      try {
        return { success: true, availability: getService().getAvailability() };
      } catch (error) {
        console.error('[BrowserCredentials] Failed to check availability:', error);
        return { success: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    BrowserCredentialIpc.RequestAccess,
    (): BrowserCredentialAvailabilityResponse => {
      try {
        return { success: true, availability: getService().requestAccess() };
      } catch (error) {
        console.error('[BrowserCredentials] Failed to request secure storage access:', error);
        return { success: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(BrowserCredentialIpc.List, (): BrowserCredentialListResponse => {
    try {
      return { success: true, credentials: getService().list() };
    } catch (error) {
      console.error('[BrowserCredentials] Failed to list credentials:', error);
      return { success: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(
    BrowserCredentialIpc.Save,
    (_event, request?: BrowserCredentialSaveRequest): BrowserCredentialMutationResponse => {
      try {
        if (!request || typeof request !== 'object') {
          throw new Error('Browser credential details are required.');
        }
        return { success: true, credential: getService().save(request) };
      } catch (error) {
        console.error('[BrowserCredentials] Failed to save credential:', error);
        return { success: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    BrowserCredentialIpc.Delete,
    (_event, request?: BrowserCredentialDeleteRequest): BrowserCredentialMutationResponse => {
      try {
        if (!request || typeof request.id !== 'string' || !request.id.trim()) {
          throw new Error('A browser credential ID is required.');
        }
        if (!getService().delete(request.id)) {
          throw new Error('The saved browser credential no longer exists.');
        }
        return { success: true };
      } catch (error) {
        console.error('[BrowserCredentials] Failed to delete credential:', error);
        return { success: false, error: errorMessage(error) };
      }
    },
  );
};
