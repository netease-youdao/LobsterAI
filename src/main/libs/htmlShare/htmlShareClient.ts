import fs from 'fs';

import {
  HtmlShareAccessMode,
  type HtmlShareAnalytics,
  type HtmlShareAnalyticsResult,
  type HtmlShareConfigurableStatus,
  type HtmlShareDisabledSource,
  HtmlShareErrorCode,
  type HtmlShareFailureDetails,
  HtmlShareFailureKind,
  type HtmlShareFailureKind as HtmlShareFailureKindValue,
  type HtmlSharePermanentDeleteResult,
  HtmlShareSourceType,
  HtmlShareStatus,
  type HtmlShareStatus as HtmlShareStatusValue,
} from '../../../shared/htmlShare/constants';
import {
  normalizePublishingQuotaErrorData,
  normalizePublishingSubscriptionRecoveryMode,
  normalizePublishingTrialPolicy,
  type PublishingQuota,
  type PublishingQuotaErrorData,
  type PublishingSubscriptionRecoveryMode,
  type PublishingTrialPolicy,
} from '../../../shared/publishing/constants';

export interface CreateHtmlShareUploadInput {
  archivePath: string;
  sourceType: (typeof HtmlShareSourceType)[keyof typeof HtmlShareSourceType];
  clientSourceKey?: string;
  sessionId?: string;
  artifactId?: string;
  title: string;
  entryFile: string;
  accessMode?: (typeof HtmlShareAccessMode)[keyof typeof HtmlShareAccessMode];
  sourceSha256: string;
}

export interface HtmlShareCreateResult {
  success: boolean;
  shareId?: string;
  url?: string;
  accessMode?: (typeof HtmlShareAccessMode)[keyof typeof HtmlShareAccessMode];
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  status?: HtmlShareStatusValue;
  moderationStatus?: string;
  updatedAt?: string;
  contentUpdatedAt?: string;
  accessExpiresAt?: string | null;
  subscriptionRecoveryMode?: PublishingSubscriptionRecoveryMode;
  disabledAt?: string | null;
  disabledReason?: string | null;
  disabledSource?: HtmlShareDisabledSource | null;
  restoredByUpdate?: boolean;
  error?: string;
  code?: number;
  failureKind?: HtmlShareFailureKindValue;
  details?: HtmlShareFailureDetails;
  quota?: PublishingQuotaErrorData;
}

export interface HtmlShareQuotaResult {
  success: boolean;
  data?: PublishingQuota;
  error?: string;
  code?: number;
}

export interface PublishingTrialPolicyResult {
  success: boolean;
  data?: PublishingTrialPolicy;
  error?: string;
  code?: number;
}

export interface HtmlShareLookupResult {
  success: boolean;
  share?: HtmlShareCreateResult | null;
  error?: string;
  code?: number;
}

export interface GeneratedVideoShareInput {
  taskId: string;
  outputIndex: number;
  sessionId: string;
  artifactId: string;
  title: string;
  accessMode?: (typeof HtmlShareAccessMode)[keyof typeof HtmlShareAccessMode];
}

export interface GeneratedVideoShareSourceResult extends HtmlShareLookupResult {
  state?: string;
  taskId?: string;
  outputIndex?: number;
  assetStatus?: string;
  retryAfterMs?: number;
  failureReason?: string;
  limitBytes?: number;
}

export interface GeneratedVideoLegacyResolveResult {
  success: boolean;
  taskId?: string;
  outputIndex?: number;
  error?: string;
  code?: number;
}

type FetchWithAuth = (url: string, options?: RequestInit) => Promise<Response>;

interface HtmlShareApiData extends Partial<PublishingQuota> {
  shareId?: string;
  url?: string;
  accessMode?: (typeof HtmlShareAccessMode)[keyof typeof HtmlShareAccessMode];
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  status?: HtmlShareStatusValue;
  moderationStatus?: string;
  updatedAt?: string;
  contentUpdatedAt?: string;
  accessExpiresAt?: string | null;
  subscriptionRecoveryMode?: unknown;
  disabledAt?: string | null;
  disabledReason?: string | null;
  disabledSource?: HtmlShareDisabledSource | null;
  restoredByUpdate?: boolean;
  limitBytes?: number;
  actualBytes?: number;
}

interface HtmlShareApiResponse {
  code: number;
  message?: string;
  data?: HtmlShareApiData;
}

interface GeneratedVideoApiData {
  state?: string;
  taskId?: string | number;
  outputIndex?: number;
  assetStatus?: string;
  retryAfterMs?: number;
  failureReason?: string;
  limitBytes?: number;
  share?: HtmlShareApiData | null;
}

interface GeneratedVideoApiResponse {
  code: number;
  message?: string;
  data?: GeneratedVideoApiData;
}

interface GeneratedVideoLegacyApiResponse {
  code: number;
  message?: string;
  data?: {
    taskId?: string | number;
    outputIndex?: number;
  };
}

interface PublishingTrialPolicyApiResponse {
  code: number;
  message?: string;
  data?: unknown;
}

interface HtmlShareListApiResponse {
  code: number;
  message?: string;
  data?: unknown;
}

interface HtmlShareAnalyticsApiResponse {
  code: number;
  message?: string;
  data?: HtmlShareAnalytics;
}

export function buildHtmlSharePublicUrl(publicBaseUrl: string, shareId: string): string {
  const normalizedBaseUrl = publicBaseUrl.trim().replace(/\/+$/, '');
  return `${normalizedBaseUrl}/${encodeURIComponent(shareId)}/`;
}

function appendHtmlShareFormData(form: FormData, input: CreateHtmlShareUploadInput, buffer: Buffer): void {
  const archiveBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  if (input.clientSourceKey) form.set('clientSourceKey', input.clientSourceKey);
  if (input.sessionId) form.set('sessionId', input.sessionId);
  if (input.artifactId) form.set('artifactId', input.artifactId);
  form.set('title', input.title);
  form.set('entryFile', input.entryFile);
  if (input.accessMode) form.set('accessMode', input.accessMode);
  form.set('sourceSha256', input.sourceSha256);
  form.set('archive', new Blob([archiveBuffer], { type: 'application/zip' }), 'share.zip');
}

function buildHtmlShareResult(
  payload: HtmlShareApiResponse,
  publicBaseUrl: string,
): HtmlShareCreateResult | null {
  if (!payload.data) return null;
  const responseShareUrl = payload.data.url?.trim();
  const shareUrl =
    responseShareUrl ||
    (payload.data.shareId ? buildHtmlSharePublicUrl(publicBaseUrl, payload.data.shareId) : undefined);
  if (!shareUrl) return null;
  return {
    success: true,
    shareId: payload.data.shareId,
    url: shareUrl,
    accessMode: payload.data.accessMode,
    shareCode: payload.data.shareCode,
    shareCodeUnavailable: payload.data.shareCodeUnavailable,
    status: payload.data.status,
    moderationStatus: payload.data.moderationStatus,
    updatedAt: payload.data.updatedAt,
    contentUpdatedAt: payload.data.contentUpdatedAt,
    ...(Object.prototype.hasOwnProperty.call(payload.data, 'accessExpiresAt')
      ? { accessExpiresAt: payload.data.accessExpiresAt }
      : {}),
    subscriptionRecoveryMode: normalizePublishingSubscriptionRecoveryMode(
      payload.data.subscriptionRecoveryMode,
    ),
    disabledAt: payload.data.disabledAt,
    disabledReason: payload.data.disabledReason,
    disabledSource: payload.data.disabledSource,
    restoredByUpdate: payload.data.restoredByUpdate,
  };
}

function buildHtmlShareFailure(
  payload: HtmlShareApiResponse | null,
  fallbackError: string,
): HtmlShareCreateResult {
  const quota = normalizePublishingQuotaErrorData(payload?.data);
  const sizeDetails = payload?.code === HtmlShareErrorCode.TooLarge
    ? {
        ...(typeof payload.data?.limitBytes === 'number'
          ? { limitBytes: payload.data.limitBytes }
          : {}),
        ...(typeof payload.data?.actualBytes === 'number'
          ? { actualBytes: payload.data.actualBytes }
          : {}),
      }
    : undefined;
  return {
    success: false,
    error: payload?.message || fallbackError,
    code: payload?.code,
    ...(sizeDetails
      ? {
          failureKind: HtmlShareFailureKind.FileTooLarge,
          details: sizeDetails,
        }
      : {}),
    ...(quota ? { quota } : {}),
  };
}

function buildGeneratedVideoSourceResult(
  payload: GeneratedVideoApiResponse,
  publicBaseUrl: string,
): GeneratedVideoShareSourceResult {
  const share = payload.data?.share
    ? buildHtmlShareResult({ code: payload.code, data: payload.data.share }, publicBaseUrl)
    : null;
  return {
    success: payload.code === 0,
    share,
    state: payload.data?.state,
    taskId: payload.data?.taskId === undefined ? undefined : String(payload.data.taskId),
    outputIndex: payload.data?.outputIndex,
    assetStatus: payload.data?.assetStatus,
    retryAfterMs: payload.data?.retryAfterMs,
    failureReason: payload.data?.failureReason,
    limitBytes: payload.data?.limitBytes,
    error: payload.code === 0 ? undefined : payload.message,
    code: payload.code,
  };
}

function generatedVideoTerminalCode(result: GeneratedVideoShareSourceResult): number | undefined {
  if (result.failureReason === 'too_large') {
    return HtmlShareErrorCode.TooLarge;
  }
  if (result.assetStatus === 'source_unavailable' || result.failureReason === 'source_unavailable') {
    return HtmlShareErrorCode.VideoSourceUnavailable;
  }
  if (result.assetStatus === 'invalid' || result.failureReason === 'prepare_failed') {
    return HtmlShareErrorCode.VideoPrepareFailed;
  }
  return undefined;
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function getRecordString(record: Record<string, unknown>, fieldName: string): string | undefined {
  const value = record[fieldName];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getNestedRecord(record: Record<string, unknown>, fieldName: string): Record<string, unknown> | null {
  const value = record[fieldName];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getHtmlShareListItems(data: unknown): Record<string, unknown>[] {
  const source = (() => {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    const record = data as Record<string, unknown>;
    for (const fieldName of ['items', 'shares', 'list', 'records', 'rows']) {
      const value = record[fieldName];
      if (Array.isArray(value)) return value;
    }
    return [];
  })();

  return source.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item)),
  );
}

function getShareRecordSourceType(record: Record<string, unknown>): string | undefined {
  return getRecordString(record, 'sourceType') ?? getRecordString(getNestedRecord(record, 'source') ?? {}, 'type');
}

function getShareRecordClientSourceKey(record: Record<string, unknown>): string | undefined {
  return (
    getRecordString(record, 'clientSourceKey') ??
    getRecordString(record, 'sourceKey') ??
    getRecordString(getNestedRecord(record, 'source') ?? {}, 'clientSourceKey') ??
    getRecordString(getNestedRecord(record, 'source') ?? {}, 'key')
  );
}

function findHtmlShareByClientSourceKey(
  data: unknown,
  sourceType: (typeof HtmlShareSourceType)[keyof typeof HtmlShareSourceType],
  clientSourceKey: string,
): Record<string, unknown> | null {
  return (
    getHtmlShareListItems(data).find(item => {
      const itemSourceType = getShareRecordSourceType(item);
      const itemClientSourceKey = getShareRecordClientSourceKey(item);
      return itemSourceType === sourceType && itemClientSourceKey === clientSourceKey;
    }) ?? null
  );
}

export async function uploadHtmlShare(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  input: CreateHtmlShareUploadInput,
): Promise<HtmlShareCreateResult> {
  const buffer = await fs.promises.readFile(input.archivePath);
  console.debug(
    `[HtmlShare] prepared ${buffer.length} bytes for ${input.sourceType} upload to ${serverBaseUrl}`,
  );
  console.debug(
    `[HtmlShare] upload request uses access mode ${input.accessMode ?? 'server-default'}, entry ${input.entryFile}, and hash ${input.sourceSha256}`,
  );
  const form = new FormData();
  form.set('sourceType', input.sourceType);
  appendHtmlShareFormData(form, input, buffer);

  const response = await fetchWithAuth(`${serverBaseUrl}/api/html-shares`, {
    method: 'POST',
    body: form,
  });
  console.debug(
    `[HtmlShare] upload response returned HTTP ${response.status} with content type ${response.headers.get('content-type') || 'unknown'}`,
  );

  let payload: HtmlShareApiResponse | null = null;
  try {
    payload = (await response.json()) as HtmlShareApiResponse;
  } catch {
    console.debug('[HtmlShare] upload response did not contain JSON');
    // Non-JSON errors are handled below.
  }
  console.debug(
    `[HtmlShare] upload response API code was ${payload?.code ?? 'missing'} and message was ${payload?.message || 'empty'}`,
  );

  const result = payload ? buildHtmlShareResult(payload, publicBaseUrl) : null;

  if (!response.ok || payload?.code !== 0 || !result) {
    console.debug(
      `[HtmlShare] upload failed with HTTP ${response.status}, API code ${payload?.code ?? 'missing'}, and share URL ${result?.url ? 'present' : 'missing'}`,
    );
    return buildHtmlShareFailure(payload, `Share upload failed: ${response.status}`);
  }

  console.debug(
    `[HtmlShare] upload succeeded with share ${payload.data.shareId || 'missing'} and status ${payload.data.status || 'missing'}`,
  );
  return result;
}

export async function updateHtmlShare(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
  input: CreateHtmlShareUploadInput,
): Promise<HtmlShareCreateResult> {
  const buffer = await fs.promises.readFile(input.archivePath);
  const form = new FormData();
  form.set('sourceType', input.sourceType);
  appendHtmlShareFormData(form, input, buffer);

  const response = await fetchWithAuth(`${serverBaseUrl}/api/html-shares/${encodeURIComponent(shareId)}`, {
    method: 'PUT',
    body: form,
  });
  const payload = (await response.json().catch((): null => null)) as HtmlShareApiResponse | null;
  const result = payload ? buildHtmlShareResult(payload, publicBaseUrl) : null;
  if (!response.ok || payload?.code !== 0 || !result) {
    return buildHtmlShareFailure(payload, `Share update failed: ${response.status}`);
  }
  return result;
}

export async function updateHtmlShareStatus(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
  status: HtmlShareConfigurableStatus,
): Promise<HtmlShareCreateResult> {
  if (status !== HtmlShareStatus.Live && status !== HtmlShareStatus.Disabled) {
    return {
      success: false,
      error: 'HTML share status must be live or disabled.',
    };
  }
  const response = await fetchWithAuth(
    `${serverBaseUrl}/api/html-shares/${encodeURIComponent(shareId)}/status`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
    },
  );
  const payload = (await response.json().catch((): null => null)) as HtmlShareApiResponse | null;
  const result = payload ? buildHtmlShareResult(payload, publicBaseUrl) : null;
  if (!response.ok || payload?.code !== 0 || !result) {
    return buildHtmlShareFailure(payload, `Share status update failed: ${response.status}`);
  }
  return result;
}

export async function updateHtmlShareAccessMode(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
  accessMode: (typeof HtmlShareAccessMode)[keyof typeof HtmlShareAccessMode],
): Promise<HtmlShareCreateResult> {
  if (accessMode !== HtmlShareAccessMode.Code && accessMode !== HtmlShareAccessMode.Public) {
    return {
      success: false,
      error: 'Invalid share access mode.',
    };
  }

  const response = await fetchWithAuth(
    `${serverBaseUrl}/api/html-shares/${encodeURIComponent(shareId)}/access-mode`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessMode }),
    },
  );
  const payload = (await response.json().catch((): null => null)) as HtmlShareApiResponse | null;
  const result = payload ? buildHtmlShareResult(payload, publicBaseUrl) : null;
  if (!response.ok || payload?.code !== 0 || !result) {
    return buildHtmlShareFailure(payload, `Share access mode update failed: ${response.status}`);
  }
  return result;
}

export async function deleteHtmlSharePermanently(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
): Promise<HtmlSharePermanentDeleteResult> {
  const response = await fetchWithAuth(
    `${serverBaseUrl}/api/html-shares/${encodeURIComponent(shareId)}/permanent`,
    { method: 'DELETE' },
  );
  const payload = (await response.json().catch((): null => null)) as HtmlShareApiResponse | null;
  if (!response.ok || payload?.code !== 0) {
    return {
      success: false,
      error: payload?.message || `Share deletion failed: ${response.status}`,
      code: payload?.code,
      httpStatus: response.status,
    };
  }
  return { success: true, httpStatus: response.status };
}

export async function getHtmlShareBySource(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  sourceType: (typeof HtmlShareSourceType)[keyof typeof HtmlShareSourceType],
  clientSourceKey: string,
): Promise<HtmlShareLookupResult> {
  const params = new URLSearchParams({
    sourceType,
    clientSourceKey,
    includeDisabled: 'true',
  });
  const response = await fetchWithAuth(`${serverBaseUrl}/api/html-shares/source?${params.toString()}`);
  const payload = (await response.json().catch((): null => null)) as HtmlShareApiResponse | null;
  if (!response.ok || payload?.code !== 0) {
    return {
      success: false,
      error: payload?.message || `Share lookup failed: ${response.status}`,
      code: payload?.code,
    };
  }
  const share = payload ? buildHtmlShareResult(payload, publicBaseUrl) : null;
  if (share) {
    return {
      success: true,
      share,
    };
  }

  const listResponse = await fetchWithAuth(`${serverBaseUrl}/api/html-shares/my`);
  const listPayload = (await listResponse.json().catch((): null => null)) as
    | HtmlShareListApiResponse
    | null;
  if (!listResponse.ok || listPayload?.code !== 0) {
    return {
      success: false,
      error: listPayload?.message || `Share list failed: ${listResponse.status}`,
      code: listPayload?.code,
    };
  }
  const fallbackShare = listPayload
    ? buildHtmlShareResult(
        {
          code: 0,
          data: findHtmlShareByClientSourceKey(
            listPayload.data,
            sourceType,
            clientSourceKey,
          ) as HtmlShareApiResponse['data'],
        },
        publicBaseUrl,
      )
    : null;
  return {
    success: true,
    share: fallbackShare,
  };
}

export async function getGeneratedVideoShareSource(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  taskId: string,
  outputIndex: number,
): Promise<GeneratedVideoShareSourceResult> {
  const params = new URLSearchParams({
    taskId,
    outputIndex: String(outputIndex),
  });
  const response = await fetchWithAuth(
    `${serverBaseUrl}/api/html-shares/generated-videos/source?${params.toString()}`,
    { cache: 'no-store' },
  );
  const payload = (await response.json().catch((): null => null)) as
    | GeneratedVideoApiResponse
    | null;
  if (!response.ok || payload?.code !== 0) {
    return {
      success: false,
      error: payload?.message || `Generated video share lookup failed: ${response.status}`,
      code: payload?.code,
    };
  }
  return buildGeneratedVideoSourceResult(payload, publicBaseUrl);
}

async function prepareGeneratedVideoShare(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  input: GeneratedVideoShareInput,
): Promise<GeneratedVideoShareSourceResult | HtmlShareCreateResult> {
  const response = await fetchWithAuth(`${serverBaseUrl}/api/html-shares/generated-videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = (await response.json().catch((): null => null)) as
    | GeneratedVideoApiResponse
    | null;
  if ((!response.ok && response.status !== 202) || payload?.code !== 0) {
    return buildHtmlShareFailure(
      payload as unknown as HtmlShareApiResponse | null,
      `Generated video share failed: ${response.status}`,
    );
  }
  if (!payload) {
    return {
      success: false,
      code: HtmlShareErrorCode.VideoPrepareFailed,
      error: 'Generated video share returned an empty response.',
    };
  }
  return buildGeneratedVideoSourceResult(payload, publicBaseUrl);
}

export async function createGeneratedVideoShare(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  input: GeneratedVideoShareInput,
): Promise<HtmlShareCreateResult> {
  const deadline = Date.now() + 3 * 60 * 1000;
  let shouldPrepare = true;
  while (Date.now() < deadline) {
    const result = shouldPrepare
      ? await prepareGeneratedVideoShare(serverBaseUrl, publicBaseUrl, fetchWithAuth, input)
      : await getGeneratedVideoShareSource(
          serverBaseUrl,
          publicBaseUrl,
          fetchWithAuth,
          input.taskId,
          input.outputIndex,
        );
    if (!result.success) return result;
    if ('share' in result && result.share?.success) return result.share;

    const source = result as GeneratedVideoShareSourceResult;
    const terminalCode = generatedVideoTerminalCode(source);
    if (terminalCode) {
      return {
        success: false,
        code: terminalCode,
        error: source.failureReason || 'Generated video is unavailable for sharing.',
        ...(terminalCode === HtmlShareErrorCode.TooLarge
          ? {
              failureKind: HtmlShareFailureKind.FileTooLarge,
              details: typeof source.limitBytes === 'number'
                ? { limitBytes: source.limitBytes }
                : undefined,
            }
          : {}),
      };
    }
    shouldPrepare = source.state === 'prepared' || source.assetStatus === 'persisted';
    await wait(Math.max(250, Math.min(5000, source.retryAfterMs ?? 1500)));
  }
  return {
    success: false,
    code: HtmlShareErrorCode.VideoPrepareFailed,
    error: 'Generated video is still being prepared. Please try again.',
  };
}

export async function resolveLegacyGeneratedVideoSource(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  resultUrlSha256: string,
): Promise<GeneratedVideoLegacyResolveResult> {
  const response = await fetchWithAuth(
    `${serverBaseUrl}/api/html-shares/generated-videos/resolve-legacy-source`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resultUrlSha256 }),
    },
  );
  const payload = (await response.json().catch((): null => null)) as
    | GeneratedVideoLegacyApiResponse
    | null;
  if (!response.ok || payload?.code !== 0 || payload.data?.taskId === undefined
      || !Number.isInteger(payload.data.outputIndex)) {
    return {
      success: false,
      error: payload?.message || `Generated video source resolution failed: ${response.status}`,
      code: payload?.code,
    };
  }
  return {
    success: true,
    taskId: String(payload.data.taskId),
    outputIndex: payload.data.outputIndex,
  };
}

export async function getHtmlShareAnalytics(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  shareId: string,
  options: { from?: string; to?: string } = {},
): Promise<HtmlShareAnalyticsResult> {
  const params = new URLSearchParams();
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const response = await fetchWithAuth(
    `${serverBaseUrl}/api/html-shares/${encodeURIComponent(shareId)}/analytics${query}`,
  );
  const payload = (await response.json().catch((): null => null)) as
    | HtmlShareAnalyticsApiResponse
    | null;
  if (!response.ok || payload?.code !== 0 || !payload.data) {
    return {
      success: false,
      error: payload?.message || `Share analytics request failed: ${response.status}`,
      code: payload?.code,
    };
  }
  return {
    success: true,
    analytics: payload.data,
  };
}

export async function getHtmlShareQuota(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
): Promise<HtmlShareQuotaResult> {
  const response = await fetchWithAuth(`${serverBaseUrl}/api/html-shares/quota`);
  const payload = (await response.json().catch((): null => null)) as HtmlShareApiResponse | null;
  const normalized = normalizePublishingQuotaErrorData(payload?.data);
  if (
    !response.ok
    || payload?.code !== 0
    || !normalized
    || typeof payload.data?.allowed !== 'boolean'
    || typeof payload.data.remaining !== 'number'
  ) {
    return {
      success: false,
      error: payload?.message || `Share quota request failed: ${response.status}`,
      code: payload?.code,
    };
  }
  return {
    success: true,
    data: {
      ...normalized,
      allowed: payload.data.allowed,
      remaining: payload.data.remaining,
      ...(payload.data.planName ? { planName: payload.data.planName } : {}),
      ...(payload.data.planDisplayName
        ? { planDisplayName: payload.data.planDisplayName }
        : {}),
    },
  };
}

export async function getPublishingTrialPolicy(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
): Promise<PublishingTrialPolicyResult> {
  const response = await fetchWithAuth(`${serverBaseUrl}/api/publishing/trial-policy`, {
    cache: 'no-store',
  });
  const payload = (await response.json().catch((): null => null)) as
    | PublishingTrialPolicyApiResponse
    | null;
  const policy = normalizePublishingTrialPolicy(payload?.data);
  if (!response.ok || payload?.code !== 0 || !policy) {
    return {
      success: false,
      error: payload?.message || `Publishing trial policy request failed: ${response.status}`,
      code: payload?.code,
    };
  }
  return { success: true, data: policy };
}
