import type {
  HtmlShareAccessMode,
  HtmlShareConfigurableStatus,
} from '../../../shared/htmlShare/constants';
import {
  normalizePublishingQuotaErrorData,
  normalizePublishingSubscriptionRecoveryMode,
} from '../../../shared/publishing/constants';
import type {
  SiteAnalytics,
  SiteAnalyticsOptions,
  SiteDeploymentQuota,
  SiteDeploymentQuotaOptions,
  SiteDetail,
  SiteListData,
  SiteListItem,
  SiteListOptions,
  SiteQuotaReservation,
  SiteQuotaReservationInput,
  SiteResult,
} from '../../../shared/site/constants';

type FetchWithAuth = (url: string, options?: RequestInit) => Promise<Response>;

interface SiteApiResponse<T> {
  code?: number;
  message?: string;
  data?: T;
}

const readResponse = async <T>(response: Response): Promise<SiteResult<T>> => {
  const body = (await response.json().catch((): null => null)) as SiteApiResponse<T> | null;
  if (response.ok && body?.code === 0 && body.data !== undefined) {
    return { success: true, data: body.data };
  }
  const quota = normalizePublishingQuotaErrorData(body?.data);
  return {
    success: false,
    code: body?.code ?? response.status,
    error: body?.message || response.statusText || 'Site request failed',
    ...(quota ? { quota } : {}),
  };
};

const request = async <T>(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  path: string,
  options?: RequestInit,
): Promise<SiteResult<T>> => {
  try {
    return await readResponse<T>(await fetchWithAuth(`${serverBaseUrl}${path}`, options));
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Site request failed',
    };
  }
};

const jsonOptions = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const normalizeSiteRecoveryMode = <T extends SiteListItem>(site: T): T => {
  const subscriptionRecoveryMode = normalizePublishingSubscriptionRecoveryMode(
    (site as SiteListItem).subscriptionRecoveryMode,
  );
  const normalized = { ...site };
  if (subscriptionRecoveryMode === undefined) {
    delete normalized.subscriptionRecoveryMode;
  } else {
    normalized.subscriptionRecoveryMode = subscriptionRecoveryMode;
  }
  return normalized;
};

const normalizeSiteResult = <T extends SiteListItem>(result: SiteResult<T>): SiteResult<T> => (
  result.success && result.data
    ? { ...result, data: normalizeSiteRecoveryMode(result.data) }
    : result
);

export const listSites = async (
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  options: SiteListOptions,
): Promise<SiteResult<SiteListData>> => {
  const query = new URLSearchParams({
    page: String(options.page ?? 1),
    pageSize: String(options.pageSize ?? 10),
  });
  if (options.keyword?.trim()) query.set('keyword', options.keyword.trim());
  if (options.siteStatus) query.set('siteStatus', options.siteStatus);
  if (options.accessMode) query.set('accessMode', options.accessMode);
  if (options.siteKind) query.set('siteKind', options.siteKind);
  const result = await request<SiteListData>(
    serverBaseUrl,
    fetchWithAuth,
    `/api/sites?${query.toString()}`,
  );
  return result.success && result.data
    ? { ...result, data: { ...result.data, list: result.data.list.map(normalizeSiteRecoveryMode) } }
    : result;
};

export const getSite = async (
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
): Promise<SiteResult<SiteDetail>> => normalizeSiteResult(await request(
  serverBaseUrl,
  fetchWithAuth,
  `/api/sites/${encodeURIComponent(shareId)}`,
));

export const updateSiteTitle = async (
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
  title: string,
): Promise<SiteResult<SiteDetail>> => normalizeSiteResult(await request(
    serverBaseUrl,
    fetchWithAuth,
    `/api/sites/${encodeURIComponent(shareId)}`,
    jsonOptions('PATCH', { title }),
  ));

export const updateSiteAccessMode = async (
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
  accessMode: HtmlShareAccessMode,
): Promise<SiteResult<SiteDetail>> => normalizeSiteResult(await request(
    serverBaseUrl,
    fetchWithAuth,
    `/api/sites/${encodeURIComponent(shareId)}/access-mode`,
    jsonOptions('PUT', { accessMode }),
  ));

export const updateSiteAccessStatus = async (
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
  status: HtmlShareConfigurableStatus,
): Promise<SiteResult<SiteDetail>> => normalizeSiteResult(await request(
    serverBaseUrl,
    fetchWithAuth,
    `/api/sites/${encodeURIComponent(shareId)}/access-status`,
    jsonOptions('PATCH', { status }),
  ));

export const deleteSite = (
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
): Promise<SiteResult<null>> =>
  request(serverBaseUrl, fetchWithAuth, `/api/sites/${encodeURIComponent(shareId)}`, {
    method: 'DELETE',
  });

export const getSiteAnalytics = (
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
  options: SiteAnalyticsOptions,
): Promise<SiteResult<SiteAnalytics>> => {
  const query = new URLSearchParams();
  if (options.from) query.set('from', options.from);
  if (options.to) query.set('to', options.to);
  if (options.limit) query.set('limit', String(options.limit));
  const suffix = query.size ? `?${query.toString()}` : '';
  return request(
    serverBaseUrl,
    fetchWithAuth,
    `/api/sites/${encodeURIComponent(shareId)}/analytics${suffix}`,
  );
};

export const getSiteDeploymentQuota = (
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  options: SiteDeploymentQuotaOptions,
): Promise<SiteResult<SiteDeploymentQuota>> => {
  const query = new URLSearchParams({
    page: String(options.page ?? 1),
    pageSize: String(options.pageSize ?? 10),
  });
  if (options.targetShareId) query.set('targetShareId', options.targetShareId);
  if (options.keyword?.trim()) query.set('keyword', options.keyword.trim());
  return request(serverBaseUrl, fetchWithAuth, `/api/sites/deployment-quota?${query.toString()}`);
};

export const createSiteQuotaReservation = (
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  input: SiteQuotaReservationInput,
): Promise<SiteResult<SiteQuotaReservation>> =>
  request(
    serverBaseUrl,
    fetchWithAuth,
    '/api/sites/deployment-quota/reservations',
    jsonOptions('POST', input),
  );

export const releaseSiteQuotaReservation = (
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  reservationId: string,
): Promise<SiteResult<null>> =>
  request(
    serverBaseUrl,
    fetchWithAuth,
    `/api/sites/deployment-quota/reservations/${encodeURIComponent(reservationId)}`,
    { method: 'DELETE' },
  );
