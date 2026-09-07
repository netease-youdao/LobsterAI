import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  HtmlShareAccessMode,
  HtmlShareSourceType,
  HtmlShareStatus,
} from '../../../shared/htmlShare/constants';
import { normalizePublishingSubscriptionRecoveryMode } from '../../../shared/publishing/constants';
import {
  type ShareDeploymentCreateNodeInput,
  type ShareDeploymentDownloadPersistenceInput,
  type ShareDeploymentDownloadPersistenceResult,
  ShareDeploymentFailureCode,
  type ShareDeploymentFailureCode as ShareDeploymentFailureCodeValue,
  type ShareDeploymentGetByLocalServiceInput,
  ShareDeploymentKind,
  type ShareDeploymentPersistenceInfoResult,
  ShareDeploymentPersistenceUpdateMode,
  type ShareDeploymentProjectAnalysis,
  type ShareDeploymentRecord,
  type ShareDeploymentResult,
  ShareDeploymentStatus,
} from '../../../shared/shareDeployment/constants';
import { buildHtmlSharePublicUrl, getHtmlShareBySource } from '../htmlShare/htmlShareClient';

type FetchWithAuth = (url: string, options?: RequestInit) => Promise<Response>;

interface ApiResponse<T> {
  code?: number;
  message?: string;
  data?: T;
}

const MAX_API_ERROR_RESPONSE_BYTES = 64 * 1024;

interface ServerShareDeploymentResponse {
  deploymentId?: string;
  shareId?: string;
  url?: string;
  accessMode?: string;
  shareCode?: string;
  shareCodeUnavailable?: boolean;
  disabledSource?: string | null;
  status?: string;
  deploymentStatus?: string;
  deploymentKind?: string;
  runtimeLanguage?: string;
  runtimeVersion?: string;
  packageManager?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  listenPort?: number;
  sourceSha256?: string;
  sourceArchiveBytes?: number;
  provider?: string;
  region?: string;
  providerResourceId?: string;
  runtimeUrlMasked?: string;
  persistence?: ShareDeploymentRecord['persistence'];
  expiresAt?: string | null;
  subscriptionRecoveryMode?: unknown;
  lastAccessedAt?: string;
  failureMessage?: string;
  failureCode?: string;
  createdAt?: string;
  updatedAt?: string;
  events?: ShareDeploymentRecord['events'];
}

interface UploadDeploymentBaseInput extends ShareDeploymentCreateNodeInput {
  archivePath: string;
  sourceSha256: string;
  analysis: ShareDeploymentProjectAnalysis;
  archiveBytes: number;
  clientSourceKey: string;
  deploymentKind?: ShareDeploymentKind;
  entryFile?: string;
  spaFallback?: boolean;
}

export interface UploadNodeDeploymentInput extends UploadDeploymentBaseInput {
  deploymentKind?: typeof ShareDeploymentKind.NodeService;
}

export interface UploadStaticDeploymentInput extends UploadDeploymentBaseInput {
  deploymentKind: typeof ShareDeploymentKind.StaticSite;
  entryFile: string;
}

function normalizeLegacyLocalServiceUrl(localServiceUrl: string): string {
  try {
    const url = new URL(localServiceUrl.trim());
    url.hash = '';
    return url.toString().replace(/\/+$/, '/').toLowerCase();
  } catch {
    return localServiceUrl.trim().replace(/\/+$/, '/').toLowerCase();
  }
}

function normalizeLocalServiceOrigin(localServiceUrl: string): string {
  try {
    const url = new URL(localServiceUrl.trim());
    return url.origin.toLowerCase();
  } catch {
    return localServiceUrl.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function normalizeProjectDirectoryForSourceKey(projectDirectory: string): string {
  return path.resolve(projectDirectory.trim()).replace(/\\/g, '/').toLowerCase();
}

const SERVICE_DEPLOYMENT_CLIENT_SOURCE_PREFIX = 'service-deployment';
const NODE_DEPLOYMENT_CLIENT_SOURCE_V2 = 'v2';
const SERVICE_DEPLOYMENT_CLIENT_SOURCE_V3 = 'v3';
const STATIC_DEPLOYMENT_CLIENT_SOURCE_V1 = 'static:v1';

function sha256ClientSourceKey(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildLegacyServiceDeploymentClientSourceKey(input: {
  sessionId: string;
  localServiceUrl: string;
}): string {
  const normalizedUrl = normalizeLegacyLocalServiceUrl(input.localServiceUrl);
  return sha256ClientSourceKey(
    `${SERVICE_DEPLOYMENT_CLIENT_SOURCE_PREFIX}:${input.sessionId}:${normalizedUrl}`,
  );
}

function buildLegacyNodeDeploymentClientSourceKey(input: {
  sessionId: string;
  localServiceUrl: string;
}): string {
  const normalizedUrl = normalizeLegacyLocalServiceUrl(input.localServiceUrl);
  return sha256ClientSourceKey(
    `${HtmlShareSourceType.NodeServiceDeployment}:${input.sessionId}:${normalizedUrl}`,
  );
}

function buildNodeDeploymentV2ClientSourceKey(input: {
  localServiceUrl: string;
  projectDirectory?: string;
}): string | undefined {
  const normalizedProjectDirectory = input.projectDirectory?.trim()
    ? normalizeProjectDirectoryForSourceKey(input.projectDirectory)
    : '';
  if (!normalizedProjectDirectory) return undefined;

  const normalizedOrigin = normalizeLocalServiceOrigin(input.localServiceUrl);
  return sha256ClientSourceKey(
    `${HtmlShareSourceType.NodeServiceDeployment}:${NODE_DEPLOYMENT_CLIENT_SOURCE_V2}:${normalizedProjectDirectory}:${normalizedOrigin}`,
  );
}

export function buildNodeDeploymentClientSourceKey(input: {
  sessionId: string;
  localServiceUrl: string;
  projectDirectory?: string;
}): string {
  const normalizedProjectDirectory = input.projectDirectory?.trim()
    ? normalizeProjectDirectoryForSourceKey(input.projectDirectory)
    : '';
  if (!normalizedProjectDirectory) {
    return buildLegacyServiceDeploymentClientSourceKey(input);
  }

  return sha256ClientSourceKey(
    `${SERVICE_DEPLOYMENT_CLIENT_SOURCE_PREFIX}:${SERVICE_DEPLOYMENT_CLIENT_SOURCE_V3}:${normalizedProjectDirectory}`,
  );
}

function buildNodeDeploymentClientSourceKeys(input: ShareDeploymentGetByLocalServiceInput): string[] {
  return Array.from(new Set([
    buildNodeDeploymentClientSourceKey(input),
    buildLegacyServiceDeploymentClientSourceKey(input),
    buildNodeDeploymentV2ClientSourceKey(input),
    buildLegacyNodeDeploymentClientSourceKey(input),
  ].filter((key): key is string => Boolean(key))));
}

export function buildStaticDeploymentClientSourceKey(input: {
  sessionId: string;
  localServiceUrl: string;
  projectDirectory?: string;
}): string {
  const normalizedProjectDirectory = input.projectDirectory?.trim()
    ? normalizeProjectDirectoryForSourceKey(input.projectDirectory)
    : '';
  if (!normalizedProjectDirectory) {
    return sha256ClientSourceKey(
      `${HtmlShareSourceType.StaticServiceDeployment}:${input.sessionId}:${normalizeLegacyLocalServiceUrl(input.localServiceUrl)}`,
    );
  }

  return sha256ClientSourceKey(
    `${SERVICE_DEPLOYMENT_CLIENT_SOURCE_PREFIX}:${STATIC_DEPLOYMENT_CLIENT_SOURCE_V1}:${normalizedProjectDirectory}`,
  );
}

function buildDeploymentClientSourceLookups(input: ShareDeploymentGetByLocalServiceInput): Array<{
  sourceType: HtmlShareSourceType;
  clientSourceKey: string;
}> {
  const lookups = [
    {
      sourceType: HtmlShareSourceType.StaticServiceDeployment,
      clientSourceKey: buildStaticDeploymentClientSourceKey(input),
    },
    ...buildNodeDeploymentClientSourceKeys(input).map(clientSourceKey => ({
      sourceType: HtmlShareSourceType.NodeServiceDeployment,
      clientSourceKey,
    })),
  ];
  const seen = new Set<string>();
  return lookups.filter(lookup => {
    const key = `${lookup.sourceType}:${lookup.clientSourceKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeDeploymentStatus(value?: string): ShareDeploymentStatus {
  switch (value) {
    case ShareDeploymentStatus.Deploying:
      return ShareDeploymentStatus.Deploying;
    case ShareDeploymentStatus.Live:
      return ShareDeploymentStatus.Live;
    case ShareDeploymentStatus.DeployFailed:
      return ShareDeploymentStatus.DeployFailed;
    case ShareDeploymentStatus.Expired:
      return ShareDeploymentStatus.Expired;
    case ShareDeploymentStatus.Stopped:
      return ShareDeploymentStatus.Stopped;
    case ShareDeploymentStatus.Queued:
    default:
      return ShareDeploymentStatus.Queued;
  }
}

function normalizeDeploymentFailureCode(value?: string): ShareDeploymentFailureCodeValue | undefined {
  return Object.values(ShareDeploymentFailureCode).find(code => code === value);
}

function buildDeploymentRecord(
  data: ServerShareDeploymentResponse | undefined,
  publicBaseUrl: string,
): ShareDeploymentRecord | null {
  if (!data?.deploymentId) return null;
  const responseShareUrl = data.url?.trim();
  const url = responseShareUrl || (data.shareId ? buildHtmlSharePublicUrl(publicBaseUrl, data.shareId) : undefined);
  return {
    deploymentId: data.deploymentId,
    shareId: data.shareId,
    url,
    deploymentKind:
      data.deploymentKind === ShareDeploymentKind.StaticSite || data.runtimeLanguage === 'static'
        ? ShareDeploymentKind.StaticSite
        : ShareDeploymentKind.NodeService,
    accessMode:
      data.accessMode === HtmlShareAccessMode.Public
        ? HtmlShareAccessMode.Public
        : HtmlShareAccessMode.Code,
    shareCode: data.shareCode,
    shareCodeUnavailable: data.shareCodeUnavailable,
    shareStatus:
      data.status === HtmlShareStatus.Disabled
        ? HtmlShareStatus.Disabled
        : data.status === HtmlShareStatus.Failed
          ? HtmlShareStatus.Failed
          : HtmlShareStatus.Live,
    disabledSource:
      typeof data.disabledSource === 'string' && data.disabledSource.trim()
        ? data.disabledSource.trim() as ShareDeploymentRecord['disabledSource']
        : null,
    status: normalizeDeploymentStatus(data.deploymentStatus || data.status),
    runtimeLanguage: data.runtimeLanguage,
    runtimeVersion: data.runtimeVersion,
    packageManager: data.packageManager,
    installCommand: data.installCommand,
    buildCommand: data.buildCommand,
    startCommand: data.startCommand,
    targetPort: data.listenPort,
    sourceArchiveBytes: data.sourceArchiveBytes,
    sourceSha256: data.sourceSha256,
    provider: data.provider,
    providerRegion: data.region,
    providerFunctionId: data.providerResourceId,
    providerEndpoint: data.runtimeUrlMasked,
    persistence: data.persistence,
    ...(Object.prototype.hasOwnProperty.call(data, 'expiresAt')
      ? { expiresAt: data.expiresAt }
      : {}),
    subscriptionRecoveryMode: normalizePublishingSubscriptionRecoveryMode(
      data.subscriptionRecoveryMode,
    ),
    lastAccessedAt: data.lastAccessedAt,
    errorCode: normalizeDeploymentFailureCode(data.failureCode),
    errorMessage: data.failureMessage,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    events: data.events,
  };
}

function buildManifest(input: UploadNodeDeploymentInput | UploadStaticDeploymentInput): Record<string, unknown> {
  const isStaticDeployment = input.deploymentKind === ShareDeploymentKind.StaticSite;
  const persistence = input.persistence ?? input.analysis.persistence;
  const manifestPersistence =
    !isStaticDeployment && persistence?.enabled && persistence.bindings.length > 0
      ? {
          ...persistence,
          updateMode:
            input.persistenceUpdateMode ?? ShareDeploymentPersistenceUpdateMode.Preserve,
        }
      : undefined;
  return {
    schemaVersion: 1,
    deploymentKind: isStaticDeployment ? ShareDeploymentKind.StaticSite : ShareDeploymentKind.NodeService,
    runtimeLanguage: isStaticDeployment ? 'static' : 'node',
    runtimeVersion: isStaticDeployment ? undefined : input.nodeVersion,
    packageManager: input.analysis.packageManager,
    installCommand: input.installCommand,
    buildCommand: input.buildCommand,
    startCommand: isStaticDeployment ? '' : input.startCommand,
    listenPort: isStaticDeployment ? 0 : input.port,
    healthPath: '/',
    entryFile: isStaticDeployment ? input.entryFile : undefined,
    spaFallback: isStaticDeployment ? input.spaFallback ?? true : undefined,
    projectRootName: path.basename(input.analysis.projectDirectory),
    projectRootHash: crypto
      .createHash('sha256')
      .update(input.analysis.projectDirectory)
      .digest('hex')
      .slice(0, 16),
    includedFileCount: input.analysis.totalFiles,
    estimatedSourceArchiveBytes: input.archiveBytes,
    localServiceUrl: input.localServiceUrl,
    ...(manifestPersistence ? { persistence: manifestPersistence } : {}),
    env: [],
  };
}

async function readArchiveBlob(archivePath: string): Promise<Blob> {
  const buffer = await fs.promises.readFile(archivePath);
  const archiveBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  return new Blob([archiveBuffer], { type: 'application/zip' });
}

export async function uploadNodeDeployment(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  input: UploadNodeDeploymentInput,
): Promise<ShareDeploymentResult> {
  const archiveBlob = await readArchiveBlob(input.archivePath);
  const form = new FormData();
  form.set('sessionId', input.sessionId);
  form.set('artifactId', input.artifactId);
  form.set('title', input.title);
  form.set('accessMode', input.accessMode ?? HtmlShareAccessMode.Code);
  form.set('clientSourceKey', input.clientSourceKey);
  if (input.quotaReservationId) {
    form.set('quotaReservationId', input.quotaReservationId);
  }
  form.set('sourceSha256', input.sourceSha256);
  form.set('manifest', JSON.stringify(buildManifest(input)));
  form.set('sourceArchive', archiveBlob, 'deployment.zip');

  const response = await fetchWithAuth(`${serverBaseUrl}/api/share-deployments/node`, {
    method: 'POST',
    body: form,
  });
  const payload = (await response.json().catch((): null => null)) as
    | ApiResponse<ServerShareDeploymentResponse>
    | null;
  const deployment = buildDeploymentRecord(payload?.data, publicBaseUrl);
  if (!response.ok || payload?.code !== 0 || !deployment) {
    return {
      success: false,
      error: payload?.message || `Deployment request failed: ${response.status}`,
      code: payload?.code,
      analysis: input.analysis,
    };
  }
  return {
    success: true,
    deployment,
    analysis: input.analysis,
    warnings: input.analysis.warnings,
  };
}

export async function uploadStaticDeployment(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  input: UploadStaticDeploymentInput,
): Promise<ShareDeploymentResult> {
  const archiveBlob = await readArchiveBlob(input.archivePath);
  const form = new FormData();
  form.set('sessionId', input.sessionId);
  form.set('artifactId', input.artifactId);
  form.set('title', input.title);
  form.set('accessMode', input.accessMode ?? HtmlShareAccessMode.Code);
  form.set('clientSourceKey', input.clientSourceKey);
  if (input.quotaReservationId) {
    form.set('quotaReservationId', input.quotaReservationId);
  }
  form.set('sourceSha256', input.sourceSha256);
  form.set('manifest', JSON.stringify(buildManifest(input)));
  form.set('sourceArchive', archiveBlob, 'deployment.zip');

  const response = await fetchWithAuth(`${serverBaseUrl}/api/share-deployments/static`, {
    method: 'POST',
    body: form,
  });
  const payload = (await response.json().catch((): null => null)) as
    | ApiResponse<ServerShareDeploymentResponse>
    | null;
  const deployment = buildDeploymentRecord(payload?.data, publicBaseUrl);
  if (!response.ok || payload?.code !== 0 || !deployment) {
    return {
      success: false,
      error: payload?.message || `Static deployment request failed: ${response.status}`,
      code: payload?.code,
      analysis: input.analysis,
    };
  }
  return {
    success: true,
    deployment,
    analysis: input.analysis,
    warnings: input.analysis.warnings,
  };
}

export async function getNodeDeployment(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  deploymentId: string,
): Promise<ShareDeploymentResult> {
  const response = await fetchWithAuth(
    `${serverBaseUrl}/api/share-deployments/${encodeURIComponent(deploymentId)}`,
  );
  const payload = (await response.json().catch((): null => null)) as
    | ApiResponse<ServerShareDeploymentResponse>
    | null;
  const deployment = buildDeploymentRecord(payload?.data, publicBaseUrl);
  if (!response.ok || payload?.code !== 0 || !deployment) {
    return {
      success: false,
      error: payload?.message || `Deployment lookup failed: ${response.status}`,
      code: payload?.code,
    };
  }
  return {
    success: true,
    deployment,
  };
}

export async function getDeploymentPersistence(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  deploymentId: string,
): Promise<ShareDeploymentPersistenceInfoResult> {
  const response = await fetchWithAuth(
    `${serverBaseUrl}/api/share-deployments/${encodeURIComponent(deploymentId)}/persistence`,
  );
  const payload = (await response.json().catch((): null => null)) as
    | ApiResponse<ShareDeploymentRecord['persistence']>
    | null;
  if (!response.ok || payload?.code !== 0) {
    return {
      success: false,
      error: payload?.message || `Service data lookup failed: ${response.status}`,
      code: payload?.code,
    };
  }
  return {
    success: true,
    persistence: payload.data ?? null,
  };
}

export async function downloadDeploymentPersistenceArchive(
  serverBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  input: ShareDeploymentDownloadPersistenceInput,
): Promise<ShareDeploymentDownloadPersistenceResult> {
  const response = await fetchWithAuth(
    `${serverBaseUrl}/api/share-deployments/${encodeURIComponent(input.deploymentId)}/persistence/archive`,
  );
  if (response.status === 204) {
    return {
      success: true,
      empty: true,
    };
  }
  const archiveBuffer = Buffer.from(await response.arrayBuffer());
  const payload = parsePersistenceArchiveError(archiveBuffer);
  if (!response.ok && isMissingPersistenceDataError(payload?.message)) {
    return {
      success: true,
      empty: true,
    };
  }
  if (!response.ok || !hasZipArchiveSignature(archiveBuffer)) {
    return {
      success: false,
      error: payload?.message || (response.ok
        ? 'Service data download returned an invalid archive.'
        : `Service data download failed: ${response.status}`),
      code: payload?.code,
    };
  }

  const filePath = await writeDeploymentPersistenceArchive(archiveBuffer, input);
  return {
    success: true,
    filePath,
  };
}

export async function getNodeDeploymentByLocalService(
  serverBaseUrl: string,
  publicBaseUrl: string,
  fetchWithAuth: FetchWithAuth,
  input: ShareDeploymentGetByLocalServiceInput,
): Promise<ShareDeploymentResult> {
  let matchedShare: Awaited<ReturnType<typeof getHtmlShareBySource>>['share'] | undefined;
  for (const lookupCandidate of buildDeploymentClientSourceLookups(input)) {
    const lookup = await getHtmlShareBySource(
      serverBaseUrl,
      publicBaseUrl,
      fetchWithAuth,
      lookupCandidate.sourceType,
      lookupCandidate.clientSourceKey,
    );
    if (!lookup.success) {
      return {
        success: false,
        error: lookup.error,
        code: lookup.code,
      };
    }
    if (lookup.share?.shareId) {
      matchedShare = lookup.share;
      break;
    }
  }

  if (!matchedShare?.shareId) {
    return {
      success: true,
      deployment: null,
    };
  }

  const response = await fetchWithAuth(
    `${serverBaseUrl}/api/html-shares/${encodeURIComponent(matchedShare.shareId)}/deployment`,
  );
  const payload = (await response.json().catch((): null => null)) as
    | ApiResponse<ServerShareDeploymentResponse>
    | null;
  const deployment = buildDeploymentRecord(payload?.data, publicBaseUrl);
  if (!response.ok || payload?.code !== 0 || !deployment) {
    return {
      success: false,
      error: payload?.message || `Deployment lookup failed: ${response.status}`,
      code: payload?.code,
    };
  }
  return {
    success: true,
    deployment: {
      ...deployment,
      url: deployment.url || matchedShare.url,
      accessMode: matchedShare.accessMode ?? deployment.accessMode,
      shareCode: matchedShare.shareCode ?? deployment.shareCode,
      shareCodeUnavailable:
        matchedShare.shareCodeUnavailable ?? deployment.shareCodeUnavailable,
      shareStatus: matchedShare.status ?? deployment.shareStatus,
      disabledSource: matchedShare.disabledSource ?? deployment.disabledSource,
    },
  };
}

function sanitizePersistenceArchiveId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'service';
}

async function writeDeploymentPersistenceArchive(
  archiveBuffer: Buffer,
  input: ShareDeploymentDownloadPersistenceInput,
): Promise<string> {
  const archiveId = sanitizePersistenceArchiveId(input.shareId || input.deploymentId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const projectDirectory = input.projectDirectory?.trim();
  const backupRoot = projectDirectory
    ? path.join(projectDirectory, '.lobster', 'persistence', archiveId, timestamp)
    : path.join(os.homedir(), 'Downloads');
  const fileName = projectDirectory
    ? `${archiveId}-service-data.zip`
    : `${archiveId}-service-data-${timestamp}.zip`;
  await fs.promises.mkdir(backupRoot, { recursive: true });
  const filePath = path.join(backupRoot, fileName);
  await fs.promises.writeFile(filePath, archiveBuffer);
  return filePath;
}

function hasZipArchiveSignature(buffer: Buffer): boolean {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  return (
    (buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[2] === 0x05 && buffer[3] === 0x06) ||
    (buffer[2] === 0x07 && buffer[3] === 0x08)
  );
}

function parsePersistenceArchiveError(buffer: Buffer): ApiResponse<unknown> | null {
  if (buffer.length === 0 || buffer.length > MAX_API_ERROR_RESPONSE_BYTES) return null;
  try {
    const payload = JSON.parse(buffer.toString('utf8')) as ApiResponse<unknown>;
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function isMissingPersistenceDataError(message?: string): boolean {
  return message?.toLowerCase().includes('cloud data does not exist') ?? false;
}
