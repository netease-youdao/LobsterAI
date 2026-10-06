import { describe, expect, test, vi } from 'vitest';

import {
  ActivityPlacement,
  DailyCheckInAction,
} from '../../../shared/activity/constants';
import {
  ActivityAuthMode,
  executeActivityAction,
  getActivityContext,
  getActivitySlot,
} from './activityClient';

const successResponse = (data: unknown): Response => new Response(
  JSON.stringify({ code: 0, message: 'success', data }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

describe('activityClient', () => {
  test('loads a slot with the immutable client capability fields', async () => {
    const activityFetch = vi.fn(async () => successResponse({
      slotState: 'empty',
      serverTime: '2026-07-28T04:00:00',
    }));

    const result = await getActivitySlot('https://server.example', activityFetch, {
      placement: ActivityPlacement.DesktopSidebar,
      clientVersion: '2026.7.30',
      containerApiVersion: 2,
      platform: 'win32',
    });

    expect(result.success).toBe(true);
    expect(activityFetch).toHaveBeenCalledWith(
      'https://server.example/api/client-activities/slot'
        + '?placement=desktop_sidebar&clientVersion=2026.7.30'
        + '&containerApiVersion=2&platform=win32',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
      ActivityAuthMode.Optional,
    );
  });

  test('uses the bound code and revision for context without exposing a token', async () => {
    const activityFetch = vi.fn(async () => successResponse({
      activityCode: 'login-seven-days',
    }));

    await getActivityContext(
      'https://server.example',
      activityFetch,
      'login-seven-days',
      3,
    );

    expect(activityFetch).toHaveBeenCalledWith(
      'https://server.example/api/client-activities/login-seven-days/context?configRevision=3',
      expect.objectContaining({ headers: expect.any(Headers) }),
      ActivityAuthMode.Optional,
    );
  });

  test('requires the authenticated main-process fetch path for actions', async () => {
    const activityFetch = vi.fn(async () => successResponse({
      replayed: false,
      result: {},
      context: {},
    }));

    await executeActivityAction('https://server.example', activityFetch, {
      activityCode: 'login-seven-days',
      configRevision: 3,
      actionId: DailyCheckInAction.CheckIn,
      idempotencyKey: 'request-1',
    });

    expect(activityFetch).toHaveBeenCalledWith(
      'https://server.example/api/client-activities/login-seven-days/actions/check_in',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          configRevision: 3,
          idempotencyKey: 'request-1',
          payload: {},
        }),
      }),
      ActivityAuthMode.Required,
    );
  });
});
