import {
  type ActivityAction,
  type ActivityActionResponse,
  type ActivityContextResponse,
  type ActivityResult,
  type ActivitySlotResponse,
} from '../../../shared/activity/constants';

export const ActivityAuthMode = {
  Optional: 'optional',
  Required: 'required',
} as const;

export type ActivityAuthMode = typeof ActivityAuthMode[keyof typeof ActivityAuthMode];

export type ActivityFetch = (
  url: string,
  init: RequestInit | undefined,
  authMode: ActivityAuthMode,
) => Promise<Response>;

interface ApiResponse<T> {
  code?: number;
  message?: string;
  data?: T;
}

async function readResponse<T>(response: Response): Promise<ActivityResult<T>> {
  const body = await response.json().catch((): null => null) as ApiResponse<T> | null;
  if (response.ok && body?.code === 0 && body.data !== undefined) {
    return { success: true, data: body.data };
  }
  return {
    success: false,
    code: body?.code,
    httpStatus: response.status,
    error: body?.message || response.statusText || 'Activity request failed',
  };
}

async function request<T>(
  serverBaseUrl: string,
  activityFetch: ActivityFetch,
  path: string,
  authMode: ActivityAuthMode,
  init?: RequestInit,
): Promise<ActivityResult<T>> {
  try {
    const headers = new Headers(init?.headers);
    headers.set('Cache-Control', 'no-store');
    const response = await activityFetch(
      `${serverBaseUrl}${path}`,
      { ...init, headers },
      authMode,
    );
    return await readResponse<T>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Activity request failed',
    };
  }
}

export function getActivitySlot(
  serverBaseUrl: string,
  activityFetch: ActivityFetch,
  input: {
    placement: string;
    clientVersion: string;
    containerApiVersion: number;
    platform: string;
  },
): Promise<ActivityResult<ActivitySlotResponse>> {
  const query = new URLSearchParams({
    placement: input.placement,
    clientVersion: input.clientVersion,
    containerApiVersion: String(input.containerApiVersion),
    platform: input.platform,
  });
  return request(
    serverBaseUrl,
    activityFetch,
    `/api/client-activities/slot?${query.toString()}`,
    ActivityAuthMode.Optional,
  );
}

export function getActivityContext(
  serverBaseUrl: string,
  activityFetch: ActivityFetch,
  activityCode: string,
  configRevision: number,
): Promise<ActivityResult<ActivityContextResponse>> {
  const query = new URLSearchParams({ configRevision: String(configRevision) });
  return request(
    serverBaseUrl,
    activityFetch,
    `/api/client-activities/${encodeURIComponent(activityCode)}/context?${query.toString()}`,
    ActivityAuthMode.Optional,
  );
}

export function executeActivityAction(
  serverBaseUrl: string,
  activityFetch: ActivityFetch,
  input: {
    activityCode: string;
    configRevision: number;
    actionId: ActivityAction;
    idempotencyKey: string;
  },
): Promise<ActivityResult<ActivityActionResponse>> {
  return request(
    serverBaseUrl,
    activityFetch,
    `/api/client-activities/${encodeURIComponent(input.activityCode)}/actions/`
      + encodeURIComponent(input.actionId),
    ActivityAuthMode.Required,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        configRevision: input.configRevision,
        idempotencyKey: input.idempotencyKey,
        payload: {},
      }),
    },
  );
}
