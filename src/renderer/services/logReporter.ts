import type { PublishingIdentityType } from '@shared/publishing/constants';

import {
  type LogEventAction,
  LogReporterAction,
  LogReporterActionPrefix,
  LogReporterCategory,
  LogReporterEndpoint,
  LogReporterEntry,
  LogReporterProduct,
} from '../../shared/analytics/constants';
import {
  type AnalyticsIdentitySnapshot,
  getAnalyticsIdentitySnapshot,
} from './analyticsIdentity';
import { configService } from './config';
import { getInstallationId } from './installationId';

export {
  LogReporterAction,
  LogReporterActionPrefix,
  LogReporterCategory,
  LogReporterEndpoint,
  LogReporterEntry,
  LogReporterProduct,
};

type LogParamValue = string | number | boolean | null | undefined;

export type { LogEventAction };

export type LogEventParams = Record<string, LogParamValue> & {
  action: LogEventAction;
};

const logCommons = {
  _npid: LogReporterProduct.LobsterAI,
  _ncat: LogReporterCategory.Actions,
} as const;

export interface BuildLogUrlOptions {
  appVersion?: string;
  arch?: string;
  environment?: string;
  eventId?: string;
  firstKeyfrom?: string;
  identityType?: PublishingIdentityType;
  installationId?: string | null;
  isLoggedIn?: boolean;
  isSubscriber?: boolean;
  language?: string;
  latestKeyfrom?: string;
  platform?: string;
  subscriptionStatus?: string;
  userId?: string;
  timestamp?: number;
}

type LogKeyfromAttribution = {
  firstKeyfrom: string;
  latestKeyfrom: string;
};

let cachedAppVersion = '';
let appVersionPromise: Promise<string> | null = null;
let cachedInstallationId: string | null = null;
let installationIdPromise: Promise<string | null> | null = null;
let cachedKeyfromAttribution: LogKeyfromAttribution | null = null;
let keyfromAttributionPromise: Promise<LogKeyfromAttribution | null> | null = null;

interface PendingAnalyticsEvent {
  params: LogEventParams;
  identity: AnalyticsIdentitySnapshot;
  eventId: string;
  timestamp: number;
}

export interface ReportYdAnalyzerOptions {
  /**
   * Identity at the product touchpoint being attributed. This is intentionally
   * narrow: user/session identity and all other common fields still come from
   * the reporter's trusted event-time snapshot.
   */
  touchpointIdentityType?: PublishingIdentityType;
}

const PendingAnalyticsQueueLimit = 500;
const PendingAnalyticsRetryDelayMs = 1_000;
const pendingAnalyticsEvents: PendingAnalyticsEvent[] = [];
let pendingAnalyticsFlushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAnalyticsFlushPromise: Promise<void> | null = null;

const createEventId = (): string => (
  globalThis.crypto?.randomUUID?.()
  ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
);

const writeReporterLog = (level: 'debug' | 'warn', message: string, error?: unknown): void => {
  if (level === 'warn') {
    if (error === undefined) {
      console.warn(`[LogReporter] ${message}`);
    } else {
      console.warn(`[LogReporter] ${message}:`, error);
    }
  } else {
    console.debug(`[LogReporter] ${message}`);
  }
  window.electron?.log?.fromRenderer?.(level, 'LogReporter', message);
};

const getWindowAppVersion = async (): Promise<string> => {
  if (cachedAppVersion) {
    return cachedAppVersion;
  }
  if (typeof window === 'undefined' || !window.electron?.appInfo?.getVersion) {
    return '';
  }
  if (!appVersionPromise) {
    appVersionPromise = window.electron.appInfo.getVersion()
      .then(version => {
        cachedAppVersion = version || '';
        return cachedAppVersion;
      })
      .catch(error => {
        appVersionPromise = null;
        writeReporterLog('warn', 'failed to load app version for analytics', error);
        return '';
      });
  }
  return appVersionPromise;
};

const getInstallationIdForAnalytics = async (): Promise<string | null> => {
  if (cachedInstallationId) {
    return cachedInstallationId;
  }
  if (!installationIdPromise) {
    installationIdPromise = getInstallationId()
      .then(id => {
        cachedInstallationId = id;
        if (!id) installationIdPromise = null;
        return cachedInstallationId;
      })
      .catch(error => {
        installationIdPromise = null;
        writeReporterLog('warn', 'failed to load installation uuid for analytics', error);
        return null;
      });
  }
  return installationIdPromise;
};

const getWindowKeyfromAttribution = async (): Promise<LogKeyfromAttribution | null> => {
  if (cachedKeyfromAttribution) {
    return cachedKeyfromAttribution;
  }
  if (typeof window === 'undefined' || !window.electron?.appInfo?.getKeyfromAttribution) {
    return null;
  }
  if (!keyfromAttributionPromise) {
    keyfromAttributionPromise = window.electron.appInfo.getKeyfromAttribution()
      .then(attribution => {
        cachedKeyfromAttribution = {
          firstKeyfrom: attribution.firstKeyfrom || '',
          latestKeyfrom: attribution.latestKeyfrom || '',
        };
        return cachedKeyfromAttribution;
      })
      .catch(error => {
        keyfromAttributionPromise = null;
        writeReporterLog('warn', 'failed to load keyfrom attribution for analytics', error);
        return null;
      });
  }
  return keyfromAttributionPromise;
};

const getWindowPlatform = (): string => {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.electron?.platform || '';
};

const getWindowArch = (): string => {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.electron?.arch || '';
};

export const buildLogUrl = (
  params: LogEventParams,
  options: BuildLogUrlOptions = {},
): string => {
  const url = new URL(LogReporterEndpoint.YoudaoAnalyzer);
  const config = configService.getConfig();
  const identity = getAnalyticsIdentitySnapshot();
  const userId = options.userId ?? identity.userId;
  const isLoggedIn = options.isLoggedIn ?? userId.trim().length > 0;
  const firstKeyfrom = options.firstKeyfrom ?? cachedKeyfromAttribution?.firstKeyfrom;
  const latestKeyfrom = options.latestKeyfrom ?? cachedKeyfromAttribution?.latestKeyfrom;
  const installationId = options.installationId ?? cachedInstallationId;
  const environment = options.environment
    ?? (config.app?.testMode
      ? 'test'
      : config.app?.isDevelopment
        ? 'development'
        : 'production');
  const logParams: Record<string, LogParamValue> = {
    ...params,
    ...logCommons,
    app_version: options.appVersion ?? cachedAppVersion,
    os_platform: options.platform ?? getWindowPlatform(),
    os_arch: options.arch ?? getWindowArch(),
    language: options.language ?? config.language,
    environment,
    eventId: options.eventId ?? createEventId(),
    uuid: installationId,
    firstKeyfrom,
    latestKeyfrom,
    is_logged_in: isLoggedIn,
    log_Usid: userId,
    identityType: options.identityType ?? identity.identityType,
    is_subscriber: options.isSubscriber ?? identity.isSubscriber,
    subscriptionStatus: options.subscriptionStatus ?? identity.subscriptionStatus,
    uts: options.timestamp ?? Date.now(),
  };

  Object.entries(logParams).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  });

  return url.href;
};

const createPendingEvent = (
  params: LogEventParams,
  options: ReportYdAnalyzerOptions,
): PendingAnalyticsEvent => {
  const identity = getAnalyticsIdentitySnapshot();
  return {
    params: { ...params },
    identity: options.touchpointIdentityType
      ? { ...identity, identityType: options.touchpointIdentityType }
      : identity,
    eventId: createEventId(),
    timestamp: Date.now(),
  };
};

const sendPendingEvent = async (
  event: PendingAnalyticsEvent,
): Promise<'sent' | 'uuid_unavailable' | 'failed'> => {
  await Promise.all([
    getWindowAppVersion(),
    getInstallationIdForAnalytics(),
    getWindowKeyfromAttribution(),
  ]);
  if (!cachedInstallationId) return 'uuid_unavailable';

  try {
    writeReporterLog('debug', `sending event ${event.params.action}`);
    const response = await window.electron.api.fetch({
      url: buildLogUrl(event.params, {
        eventId: event.eventId,
        identityType: event.identity.identityType,
        installationId: cachedInstallationId,
        isLoggedIn: event.identity.isLoggedIn,
        isSubscriber: event.identity.isSubscriber,
        subscriptionStatus: event.identity.subscriptionStatus,
        timestamp: event.timestamp,
        userId: event.identity.userId,
      }),
      method: 'GET',
      headers: {},
    });
    if (!response.ok) {
      writeReporterLog(
        'warn',
        `event ${event.params.action} failed with status ${response.status}`,
      );
      return 'failed';
    }
    writeReporterLog('debug', `sent event ${event.params.action} successfully`);
    return 'sent';
  } catch (error) {
    writeReporterLog('warn', `event ${event.params.action} failed`, error);
    return 'failed';
  }
};

const schedulePendingAnalyticsFlush = (): void => {
  if (pendingAnalyticsFlushTimer || pendingAnalyticsEvents.length === 0) return;
  pendingAnalyticsFlushTimer = globalThis.setTimeout(() => {
    pendingAnalyticsFlushTimer = null;
    void flushPendingAnalyticsEvents();
  }, PendingAnalyticsRetryDelayMs);
};

const enqueuePendingAnalyticsEvent = (event: PendingAnalyticsEvent): void => {
  if (pendingAnalyticsEvents.length >= PendingAnalyticsQueueLimit) {
    pendingAnalyticsEvents.shift();
    writeReporterLog('warn', 'dropped the oldest pending event because the queue is full');
  }
  pendingAnalyticsEvents.push(event);
  schedulePendingAnalyticsFlush();
};

const flushPendingAnalyticsEvents = async (): Promise<void> => {
  if (pendingAnalyticsFlushPromise) return pendingAnalyticsFlushPromise;
  pendingAnalyticsFlushPromise = (async () => {
    while (
      pendingAnalyticsEvents.length > 0
      && configService.getConfig().usageAnalyticsEnabled !== false
    ) {
      const event = pendingAnalyticsEvents[0];
      const result = await sendPendingEvent(event);
      if (result === 'uuid_unavailable') break;
      pendingAnalyticsEvents.shift();
    }
    if (configService.getConfig().usageAnalyticsEnabled === false) {
      pendingAnalyticsEvents.splice(0, pendingAnalyticsEvents.length);
    }
  })().finally(() => {
    pendingAnalyticsFlushPromise = null;
    schedulePendingAnalyticsFlush();
  });
  return pendingAnalyticsFlushPromise;
};

export const reportYdAnalyzer = async (
  params: LogEventParams,
  options: ReportYdAnalyzerOptions = {},
): Promise<boolean> => {
  if (configService.getConfig().usageAnalyticsEnabled === false) {
    writeReporterLog('debug', `skipped event ${params.action} because usage analytics is disabled`);
    return false;
  }

  if (!params.action.trim()) {
    writeReporterLog('warn', 'skipped an event without an action');
    return false;
  }

  if (!params.action.startsWith(LogReporterActionPrefix.LobsterAI)) {
    writeReporterLog('warn', 'skipped an event without the LobsterAI action prefix');
    return false;
  }

  const event = createPendingEvent(params, options);
  const result = await sendPendingEvent(event);
  if (result === 'uuid_unavailable') {
    enqueuePendingAnalyticsEvent(event);
    writeReporterLog('debug', `queued event ${params.action} until the installation uuid is ready`);
    return true;
  }
  return result === 'sent';
};
