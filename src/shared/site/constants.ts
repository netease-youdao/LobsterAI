import type { HtmlShareAccessMode, HtmlShareConfigurableStatus } from '../htmlShare/constants';
import type {
  PublishingCountMode,
  PublishingIdentityType,
  PublishingQuotaErrorData,
  PublishingResourceKind,
  PublishingSubscriptionRecoveryMode,
} from '../publishing/constants';

export const SiteIpc = {
  List: 'site:list',
  Get: 'site:get',
  UpdateTitle: 'site:updateTitle',
  UpdateAccessMode: 'site:updateAccessMode',
  UpdateAccessStatus: 'site:updateAccessStatus',
  Delete: 'site:delete',
  GetAnalytics: 'site:getAnalytics',
  GetDeploymentQuota: 'site:getDeploymentQuota',
  CreateQuotaReservation: 'site:createQuotaReservation',
  ReleaseQuotaReservation: 'site:releaseQuotaReservation',
} as const;

export type SiteIpc = (typeof SiteIpc)[keyof typeof SiteIpc];

export const SiteKind = {
  NodeService: 'node_service',
  StaticSite: 'static_site',
} as const;

export type SiteKind = (typeof SiteKind)[keyof typeof SiteKind];

export const SiteStatus = {
  Online: 'online',
  Deploying: 'deploying',
  AccessStopped: 'access_stopped',
  RedeployRequired: 'redeploy_required',
  Blocked: 'blocked',
  Failed: 'failed',
} as const;

export type SiteStatus = (typeof SiteStatus)[keyof typeof SiteStatus];

export const SiteDeploymentStatus = {
  Queued: 'queued',
  Building: 'building',
  Deploying: 'deploying',
  HealthChecking: 'health_checking',
} as const;

export type SiteDeploymentStatus =
  (typeof SiteDeploymentStatus)[keyof typeof SiteDeploymentStatus];

export const SiteFilterStatus = {
  Unavailable: 'unavailable',
} as const;

export type SiteFilterStatus =
  | SiteStatus
  | (typeof SiteFilterStatus)[keyof typeof SiteFilterStatus];

export const SiteAction = {
  Rename: 'rename',
  ChangeAccessMode: 'change_access_mode',
  StopAccess: 'stop_access',
  ResumeAccess: 'resume_access',
  Redeploy: 'redeploy',
  ViewAnalytics: 'view_analytics',
  Delete: 'delete',
} as const;

export type SiteAction = (typeof SiteAction)[keyof typeof SiteAction];

export const SiteErrorCode = {
  NotFound: 41601,
  RedeployRequired: 41604,
  AnalyticsRangeInvalid: 41606,
  ActionConflict: 41607,
  ReopenUnavailable: 41608,
  DeploymentQuotaExceeded: 41609,
  QuotaConfigInvalid: 41610,
  QuotaReservationInvalid: 41611,
  DeleteRequiresStopped: 41612,
} as const;

export interface SiteListItem {
  shareId: string;
  title: string;
  url: string;
  siteKind: SiteKind;
  siteStatus: SiteStatus;
  shareStatus: string;
  disabledSource?: string | null;
  accessMode: HtmlShareAccessMode;
  hasAccessCode: boolean;
  deploymentId?: string | null;
  deploymentStatus?: string | null;
  runtimeLanguage?: string | null;
  redeployRequired: boolean;
  lastAccessedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null;
  subscriptionRecoveryMode?: PublishingSubscriptionRecoveryMode;
}

export interface SiteDeploymentEvent {
  id?: number;
  deploymentId?: string;
  stage: string;
  level: string;
  message: string;
  createdAt: string;
}

export interface SitePersistenceInfo {
  enabled: boolean;
  provider?: string;
  mountPath?: string;
  remoteRoot?: string;
  quotaBytes?: number;
  usedBytes?: number;
  usedBytesEstimated?: boolean;
  status?: string;
}

export interface SiteDetail extends SiteListItem {
  sessionId?: string | null;
  artifactId?: string | null;
  runtimeVersion?: string | null;
  packageManager?: string | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  listenPort?: number | null;
  healthPath?: string | null;
  persistence?: SitePersistenceInfo | null;
  events: SiteDeploymentEvent[];
  shareCode?: string | null;
  shareCodeUnavailable?: boolean;
  resumeSupported: boolean;
  editableActions: SiteAction[];
  statusReason?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
}

export interface SiteListOptions {
  page?: number;
  pageSize?: number;
  keyword?: string;
  siteStatus?: SiteFilterStatus;
  accessMode?: HtmlShareAccessMode;
  siteKind?: SiteKind;
}

export interface SiteListData {
  list: SiteListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SiteAnalytics {
  summary: { pageViews: number; uniqueVisitors: number };
  trend: Array<{ date: string; pageViews: number; uniqueVisitors: number }>;
  topPages: Array<{ path: string; pageViews: number; uniqueVisitors: number }>;
  meta: {
    from: string;
    to: string;
    granularity: 'day';
    timeZone: string;
    dataScope: string;
    retentionDays: number;
    dataAvailableFrom?: string | null;
  };
}

export interface SiteAnalyticsOptions {
  from?: string;
  to?: string;
  limit?: number;
}

export interface SiteResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: number;
  quota?: PublishingQuotaErrorData;
}

export interface SiteUpdateTitleInput {
  shareId: string;
  title: string;
}

export interface SiteUpdateAccessModeInput {
  shareId: string;
  accessMode: HtmlShareAccessMode;
}

export interface SiteUpdateAccessStatusInput {
  shareId: string;
  status: HtmlShareConfigurableStatus;
}

export interface SiteQuotaCandidate {
  shareId: string;
  title: string;
  url: string;
  siteKind: SiteKind;
  siteStatus: SiteStatus;
  lastAccessedAt?: string | null;
  updatedAt?: string | null;
}

export interface SiteDeploymentQuotaOptions {
  targetShareId?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface SiteDeploymentQuota {
  allowed: boolean;
  identityType: PublishingIdentityType;
  resourceKind: PublishingResourceKind;
  countMode: PublishingCountMode;
  canReleaseByClosing: boolean;
  plan: {
    name: string;
    displayName: string;
    maxActiveSites: number;
  };
  usage: {
    used: number;
    reserved: number;
    limit: number;
    remaining: number;
    requiredStops: number;
  };
  target: {
    shareId?: string | null;
    occupiesSlot: boolean;
  };
  candidates: {
    list: SiteQuotaCandidate[];
    total: number;
    page: number;
    pageSize: number;
  };
}

export interface SiteQuotaReservationInput {
  requestKey: string;
  targetShareId?: string;
}

export interface SiteQuotaReservation {
  reservationId: string;
  slotDelta: number;
  expiresAt: string;
}
