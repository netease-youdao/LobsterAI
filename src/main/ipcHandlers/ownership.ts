import type { WebContents } from 'electron';

import { OwnershipErrorCode, OwnershipIpc } from '../../shared/ownership/constants';
import type { OwnershipCommitRequest, OwnershipResponse, OwnershipTarget } from '../../shared/ownership/types';
import { OwnershipAssociationError, type OwnershipAssociationService } from '../ownershipAssociation';
import { mainWindowHandler } from './mainWindowIpc';

export function registerOwnershipHandlers(service: () => OwnershipAssociationService | null, sender: () => WebContents | undefined): void {
  const handle = mainWindowHandler(sender);
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
  handle(OwnershipIpc.GetDetail, (_event, target: OwnershipTarget) => invoke(current => current.getDetail(target)));
  handle(OwnershipIpc.Preview, (_event, target: OwnershipTarget) => invoke(current => current.preview(target)));
  handle(OwnershipIpc.Commit, (_event, input: OwnershipCommitRequest) => invoke(current => current.commit(input)));
  handle(OwnershipIpc.GetResult, (_event, input: { requestId: string }) => invoke(current => current.getResult(input)));
}
