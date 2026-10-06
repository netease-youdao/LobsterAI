import { ipcMain } from 'electron';

import type { EnterpriseQuotaRequestType } from '../../../shared/enterpriseAccount/constants';
import { EnterpriseAccountIpcChannel } from '../../../shared/enterpriseAccount/constants';
import type {
  EnterpriseAccountContextResult,
  EnterpriseAccountIdentitiesResult,
  EnterpriseQuotaRequestResult,
} from '../../../shared/enterpriseAccount/types';

export interface EnterpriseAccountHandlerDeps {
  getContext: () => Promise<EnterpriseAccountContextResult>;
  getIdentities: () => Promise<EnterpriseAccountIdentitiesResult>;
  requestQuotaIncrease: (
    enterpriseId: number,
    requestType: EnterpriseQuotaRequestType,
  ) => Promise<EnterpriseQuotaRequestResult>;
}

export function registerEnterpriseAccountHandlers(
  deps: EnterpriseAccountHandlerDeps,
): void {
  ipcMain.handle(
    EnterpriseAccountIpcChannel.GetContext,
    () => deps.getContext(),
  );
  ipcMain.handle(
    EnterpriseAccountIpcChannel.GetIdentities,
    () => deps.getIdentities(),
  );
  ipcMain.handle(
    EnterpriseAccountIpcChannel.RequestQuotaIncrease,
    (_event, enterpriseId: number, requestType: EnterpriseQuotaRequestType) => (
      deps.requestQuotaIncrease(enterpriseId, requestType)
    ),
  );
}
