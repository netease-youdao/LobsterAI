import fs from 'fs';

import {
  HtmlShareAccessMode,
  type HtmlShareConfigurableStatus,
  type HtmlShareDisabledSource,
  HtmlShareSourceType,
  HtmlShareStatus,
  type HtmlShareStatus as HtmlShareStatusValue,
} from '../../../shared/htmlShare/constants';

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
  disabledAt?: string | null;
  disabledReason?: string | null;
  disabledSource?: HtmlShareDisabledSource | null;
  restoredByUpdate?: boolean;
  error?: string;
  code?: number;
}

export interface HtmlShareLookupResult {
  success: boolean;
  share?: HtmlShareCreateResult | null;
  error?: string;
  code?: number;
}

type FetchWithAuth = (url: string, options?: RequestInit) => Promise<Response>;

interface HtmlShareApiResponse {
  code: number;
  message?: string;
  data?: {
    shareId?: string;
    url?: string;
    accessMode?: (typeof HtmlShareAccessMode)[keyof typeof HtmlShareAccessMode];
    shareCode?: string;
    shareCodeUnavailable?: boolean;
    status?: HtmlShareStatusValue;
    moderationStatus?: string;
    updatedAt?: string;
    contentUpdatedAt?: string;
    disabledAt?: string | null;
    disabledReason?: string | null;
    disabledSource?: HtmlShareDisabledSource | null;
    restoredByUpdate?: boolean;
  };
}

interface HtmlShareListApiResponse {
  code: number;
  message?: string;
  data?: unknown;
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
    disabledAt: payload.data.disabledAt,
    disabledReason: payload.data.disabledReason,
    disabledSource: payload.data.disabledSource,
    restoredByUpdate: payload.data.restoredByUpdate,
  };
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
    return {
      success: false,
      error: payload?.message || `Share upload failed: ${response.status}`,
      code: payload?.code,
    };
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
    return {
      success: false,
      error: payload?.message || `Share update failed: ${response.status}`,
      code: payload?.code,
    };
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
    return {
      success: false,
      error: payload?.message || `Share status update failed: ${response.status}`,
      code: payload?.code,
    };
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
    return {
      success: false,
      error: payload?.message || `Share access mode update failed: ${response.status}`,
      code: payload?.code,
    };
  }
  return result;
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
