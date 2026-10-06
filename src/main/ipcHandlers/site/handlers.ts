import { ipcMain } from 'electron';

import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
  type HtmlShareConfigurableStatus,
  HtmlShareStatus,
} from '../../../shared/htmlShare/constants';
import {
  type SiteAnalyticsOptions,
  type SiteDeploymentQuotaOptions,
  SiteIpc,
  type SiteListOptions,
  type SiteQuotaReservationInput,
  type SiteResult,
  type SiteUpdateAccessModeInput,
  type SiteUpdateAccessStatusInput,
  type SiteUpdateTitleInput,
} from '../../../shared/site/constants';
import {
  createSiteQuotaReservation,
  deleteSite,
  getSite,
  getSiteAnalytics,
  getSiteDeploymentQuota,
  listSites,
  releaseSiteQuotaReservation,
  updateSiteAccessMode,
  updateSiteAccessStatus,
  updateSiteTitle,
} from '../../libs/site/siteClient';

export interface SiteHandlerDeps {
  getServerApiBaseUrl: () => string;
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
}

const requireShareId = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 64) {
    throw new Error('Invalid site identifier');
  }
  return value.trim();
};

const requireAccessMode = (value: unknown): HtmlShareAccessModeValue => {
  if (value !== HtmlShareAccessMode.Public && value !== HtmlShareAccessMode.Code) {
    throw new Error('Invalid site access mode');
  }
  return value;
};

const requireAccessStatus = (value: unknown): HtmlShareConfigurableStatus => {
  if (value !== HtmlShareStatus.Live && value !== HtmlShareStatus.Disabled) {
    throw new Error('Invalid site access status');
  }
  return value;
};

const handleSiteRequest = async <T>(
  action: string,
  request: () => Promise<SiteResult<T>>,
): Promise<SiteResult<T>> => {
  try {
    return await request();
  } catch (error) {
    console.error(`[Sites] ${action} failed:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Site request failed',
    };
  }
};

export function registerSiteIpcHandlers({
  getServerApiBaseUrl,
  fetchWithAuth,
}: SiteHandlerDeps): void {
  ipcMain.handle(SiteIpc.List, (_event, options: SiteListOptions = {}) =>
    handleSiteRequest('list request', () =>
      listSites(getServerApiBaseUrl(), fetchWithAuth, options ?? {})),
  );
  ipcMain.handle(SiteIpc.Get, (_event, shareId: unknown) =>
    handleSiteRequest('detail request', () =>
      getSite(getServerApiBaseUrl(), fetchWithAuth, requireShareId(shareId))),
  );
  ipcMain.handle(SiteIpc.UpdateTitle, (_event, input: SiteUpdateTitleInput | undefined) =>
    handleSiteRequest('title update', () =>
      updateSiteTitle(
        getServerApiBaseUrl(),
        fetchWithAuth,
        requireShareId(input?.shareId),
        typeof input?.title === 'string' ? input.title.slice(0, 100) : '',
      )),
  );
  ipcMain.handle(
    SiteIpc.UpdateAccessMode,
    (_event, input: SiteUpdateAccessModeInput | undefined) =>
      handleSiteRequest('access-mode update', () =>
        updateSiteAccessMode(
          getServerApiBaseUrl(),
          fetchWithAuth,
          requireShareId(input?.shareId),
          requireAccessMode(input?.accessMode),
        )),
  );
  ipcMain.handle(
    SiteIpc.UpdateAccessStatus,
    (_event, input: SiteUpdateAccessStatusInput | undefined) =>
      handleSiteRequest('access-status update', () =>
        updateSiteAccessStatus(
          getServerApiBaseUrl(),
          fetchWithAuth,
          requireShareId(input?.shareId),
          requireAccessStatus(input?.status),
        )),
  );
  ipcMain.handle(SiteIpc.Delete, (_event, shareId: unknown) =>
    handleSiteRequest('delete request', () =>
      deleteSite(getServerApiBaseUrl(), fetchWithAuth, requireShareId(shareId))),
  );
  ipcMain.handle(
    SiteIpc.GetAnalytics,
    (_event, shareId: unknown, options: SiteAnalyticsOptions = {}) =>
      handleSiteRequest('analytics request', () =>
        getSiteAnalytics(
          getServerApiBaseUrl(),
          fetchWithAuth,
          requireShareId(shareId),
          options ?? {},
        )),
  );
  ipcMain.handle(SiteIpc.GetDeploymentQuota, (_event, options: SiteDeploymentQuotaOptions = {}) =>
    handleSiteRequest('deployment-quota request', () =>
      getSiteDeploymentQuota(getServerApiBaseUrl(), fetchWithAuth, options ?? {})),
  );
  ipcMain.handle(
    SiteIpc.CreateQuotaReservation,
    (_event, input: SiteQuotaReservationInput | undefined) =>
      handleSiteRequest('quota-reservation creation', () => {
        if (!input || typeof input.requestKey !== 'string' || !input.requestKey.trim()) {
          throw new Error('Invalid site quota reservation request');
        }
        return createSiteQuotaReservation(getServerApiBaseUrl(), fetchWithAuth, {
          requestKey: input.requestKey.trim().slice(0, 128),
          ...(input.targetShareId
            ? { targetShareId: requireShareId(input.targetShareId) }
            : {}),
        });
      }),
  );
  ipcMain.handle(SiteIpc.ReleaseQuotaReservation, (_event, reservationId: unknown) =>
    handleSiteRequest('quota-reservation release', () =>
      releaseSiteQuotaReservation(
        getServerApiBaseUrl(),
        fetchWithAuth,
        requireShareId(reservationId),
      )),
  );
}
