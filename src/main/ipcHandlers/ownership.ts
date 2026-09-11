import { ipcMain } from 'electron';

import { OwnershipErrorCode, OwnershipIpc } from '../../shared/ownership/constants';
import type { OwnershipCommitRequest, OwnershipResponse, OwnershipTarget } from '../../shared/ownership/types';
import { OwnershipAssociationError, type OwnershipAssociationService } from '../ownershipAssociation';

export function registerOwnershipHandlers(service: () => OwnershipAssociationService | null): void {
  const invoke = <T>(operation: (current: OwnershipAssociationService) => T): OwnershipResponse<T> => {
    try {
      const current = service();
      if (!current) return { success: false, error: { code: OwnershipErrorCode.NotAvailable } };
      return { success: true, data: operation(current) };
    } catch (error) {
      if (!(error instanceof OwnershipAssociationError)) console.error('[Ownership] Operation failed', error);
      return { success: false, error: { code: error instanceof OwnershipAssociationError ? error.code : OwnershipErrorCode.LocalCommitFailed } };
    }
  };
  ipcMain.handle(OwnershipIpc.GetDetail, (_event, target: OwnershipTarget) => invoke(current => current.getDetail(target)));
  ipcMain.handle(OwnershipIpc.Preview, (_event, target: OwnershipTarget) => invoke(current => current.preview(target)));
  ipcMain.handle(OwnershipIpc.Commit, (_event, input: OwnershipCommitRequest) => invoke(current => current.commit(input)));
  ipcMain.handle(OwnershipIpc.GetResult, (_event, input: { requestId: string }) => invoke(current => current.getResult(input)));
}
