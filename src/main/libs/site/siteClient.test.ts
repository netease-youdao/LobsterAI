import { describe, expect, test, vi } from 'vitest';

import { HtmlShareAccessMode, HtmlShareStatus } from '../../../shared/htmlShare/constants';
import { SiteFilterStatus, SiteStatus } from '../../../shared/site/constants';
import {
  createSiteQuotaReservation,
  deleteSite,
  getSiteAnalytics,
  getSiteDeploymentQuota,
  listSites,
  releaseSiteQuotaReservation,
  updateSiteAccessMode,
  updateSiteAccessStatus,
} from './siteClient';

const apiResponse = (data: unknown, code = 0): Response =>
  new Response(JSON.stringify({ code, message: code === 0 ? 'success' : 'failed', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('siteClient', () => {
  test('builds a paginated filtered site list request', async () => {
    const fetchWithAuth = vi.fn(async () =>
      apiResponse({ list: [], total: 0, page: 2, pageSize: 10 }),
    );

    const result = await listSites('https://server.example', fetchWithAuth, {
      page: 2,
      pageSize: 10,
      keyword: 'portfolio',
      siteStatus: SiteStatus.Online,
    });

    expect(result.success).toBe(true);
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://server.example/api/sites?page=2&pageSize=10&keyword=portfolio&siteStatus=online',
      undefined,
    );
  });

  test('sends access changes only through explicit mutation requests', async () => {
    const fetchWithAuth = vi.fn(async () => apiResponse({ shareId: 'shr_1' }));

    await updateSiteAccessMode(
      'https://server.example',
      fetchWithAuth,
      'shr_1',
      HtmlShareAccessMode.Code,
    );
    await updateSiteAccessStatus(
      'https://server.example',
      fetchWithAuth,
      'shr_1',
      HtmlShareStatus.Disabled,
    );

    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      1,
      'https://server.example/api/sites/shr_1/access-mode',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ accessMode: 'code' }) }),
    );
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://server.example/api/sites/shr_1/access-status',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ status: 'disabled' }) }),
    );
  });

  test('permanently deletes a stopped site through an explicit delete request', async () => {
    const fetchWithAuth = vi.fn(async () => apiResponse(null));

    const result = await deleteSite('https://server.example', fetchWithAuth, 'shr_1');

    expect(result.success).toBe(true);
    expect(fetchWithAuth).toHaveBeenCalledWith('https://server.example/api/sites/shr_1', {
      method: 'DELETE',
    });
  });

  test('requests the aggregated unavailable site filter', async () => {
    const fetchWithAuth = vi.fn(async () =>
      apiResponse({ list: [], total: 0, page: 1, pageSize: 10 }),
    );

    await listSites('https://server.example', fetchWithAuth, {
      page: 1,
      pageSize: 10,
      siteStatus: SiteFilterStatus.Unavailable,
    });

    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://server.example/api/sites?page=1&pageSize=10&siteStatus=unavailable',
      undefined,
    );
  });

  test('requests analytics without logging or persisting share credentials', async () => {
    const fetchWithAuth = vi.fn(async () =>
      apiResponse({
        summary: { pageViews: 0, uniqueVisitors: 0 },
        trend: [],
        topPages: [],
        meta: {},
      }),
    );

    const result = await getSiteAnalytics('https://server.example', fetchWithAuth, 'shr_1', {
      from: '2026-07-01',
      to: '2026-07-21',
      limit: 10,
    });

    expect(result.success).toBe(true);
    expect(fetchWithAuth).toHaveBeenCalledWith(
      'https://server.example/api/sites/shr_1/analytics?from=2026-07-01&to=2026-07-21&limit=10',
      undefined,
    );
  });

  test('preflights and reserves a subscription site slot', async () => {
    const fetchWithAuth = vi.fn(async (url: string) =>
      apiResponse(
        url.includes('/reservations')
          ? { reservationId: 'qrs_1', slotDelta: 1, expiresAt: '2026-07-22T12:00:00' }
          : {
              allowed: false,
              plan: { name: 'standard', displayName: '标准', maxActiveSites: 5 },
              usage: { used: 5, reserved: 0, limit: 5, remaining: 0, requiredStops: 1 },
              target: { shareId: 'shr_target', occupiesSlot: false },
              candidates: { list: [], total: 0, page: 1, pageSize: 10 },
            },
      ),
    );

    await getSiteDeploymentQuota('https://server.example', fetchWithAuth, {
      targetShareId: 'shr_target',
      keyword: 'demo',
      page: 1,
      pageSize: 10,
    });
    await createSiteQuotaReservation('https://server.example', fetchWithAuth, {
      requestKey: 'request-1',
      targetShareId: 'shr_target',
    });
    await releaseSiteQuotaReservation('https://server.example', fetchWithAuth, 'qrs_1');

    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      1,
      'https://server.example/api/sites/deployment-quota?page=1&pageSize=10&targetShareId=shr_target&keyword=demo',
      undefined,
    );
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      2,
      'https://server.example/api/sites/deployment-quota/reservations',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchWithAuth).toHaveBeenNthCalledWith(
      3,
      'https://server.example/api/sites/deployment-quota/reservations/qrs_1',
      { method: 'DELETE' },
    );
  });

  test('preserves structured quota data on a rejected reservation', async () => {
    const fetchWithAuth = vi.fn(async () => apiResponse({
      identityType: 'free',
      resourceKind: 'site',
      countMode: 'total',
      used: 1,
      limit: 1,
      canReleaseByClosing: false,
    }, 41609));

    const result = await createSiteQuotaReservation(
      'https://server.example',
      fetchWithAuth,
      { requestKey: 'request-2' },
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe(41609);
    expect(result.quota).toEqual({
      identityType: 'free',
      resourceKind: 'site',
      countMode: 'total',
      used: 1,
      limit: 1,
      canReleaseByClosing: false,
    });
  });
});
