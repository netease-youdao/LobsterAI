// Usage analytics for the experimental DeepSeek Harness settings card. Events
// go through reportYdAnalyzer like every other settings event, so they reach
// the analyzer via `api:fetch` and show up in the main log as
// `[api:fetch] GET https://rlogs.youdao.com/rlog.php?[redacted]` lines.

import { LogReporterAction, LogReporterSource } from '../../shared/analytics/constants';
import { type DshEngineErrorCode, DshEnginePhase } from '../../shared/dshEngine/constants';
import { type LogEventParams, reportYdAnalyzer } from './logReporter';

export const DshAnalyticsActionType = {
  OpenWorkbench: 'open_workbench',
} as const;
export type DshAnalyticsActionType = typeof DshAnalyticsActionType[keyof typeof DshAnalyticsActionType];

export const DshAnalyticsSettingKey = {
  Enabled: 'dshEnabled',
} as const;
export type DshAnalyticsSettingKey = typeof DshAnalyticsSettingKey[keyof typeof DshAnalyticsSettingKey];

export const DshAnalyticsResult = {
  Success: 'success',
  Failed: 'failed',
} as const;
export type DshAnalyticsResult = typeof DshAnalyticsResult[keyof typeof DshAnalyticsResult];

// Failure classes that do not come from the engine state machine.
export const DshAnalyticsErrorCode = {
  NotEnabled: 'not_enabled',
  Unknown: 'unknown',
} as const;
export type DshAnalyticsErrorCode = typeof DshAnalyticsErrorCode[keyof typeof DshAnalyticsErrorCode];

export const DSH_ANALYTICS_ERROR_DETAIL_MAX_LENGTH = 200;

const HOME_PLACEHOLDER = '~';
const PATH_PLACEHOLDER = '<path>';

// Electron wraps a rejected ipcRenderer.invoke in this prefix; it carries no
// information beyond the channel name.
const IPC_ERROR_PREFIX_PATTERN = /^Error invoking remote method '[^']*': (?:Error: )?/;
// Query strings and fragments are where URLs carry tokens; the origin and
// path of a loopback URL are harmless and useful.
const URL_QUERY_PATTERN = /(https?:\/\/[^\s?#'"]+)[?#][^\s'"]*/gi;
// A user name as it appears in a path segment: words separated by single
// spaces (macOS and Windows allow spaces in account names), stopping at
// separators and punctuation so surrounding prose is not swallowed.
const USER_NAME = "[^\\s/\\\\:'\"`,;()[\\]<>]+(?: [^\\s/\\\\:'\"`,;()[\\]<>]+)*";
// Standard home locations. The renderer cannot ask for os.homedir(), so the
// platform conventions stand in for it: /Users/<name>, /home/<name>, and
// <drive>:\Users\<name> with either separator.
const POSIX_HOME_PATTERN = new RegExp(`(?<![\\w~])/(?:Users|home)/${USER_NAME}`, 'g');
const WINDOWS_HOME_PATTERN = new RegExp(`(?<![\\w~])[A-Za-z]:[\\\\/]Users[\\\\/]${USER_NAME}`, 'gi');
// Two or more POSIX segments not already attached to `~`, a word, or another
// slash (so a `~/Library/...` tail and the `//host/path` part of a URL survive).
const POSIX_PATH_PATTERN = /(?<![\w~/])(?:\/[^\s/:'"`,;()[\]<>]+){2,}\/?/g;
// Drive-letter Windows paths, either separator.
const WINDOWS_PATH_PATTERN = /(?<![\w~])[A-Za-z]:[\\/](?:[^\s\\/:'"`,;()[\]<>]+[\\/]?)+/g;

const NOT_ENABLED_MESSAGE_FRAGMENT = 'is not enabled';

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return String(error);
  } catch {
    return '';
  }
};

/**
 * Reduces an error to a short diagnostic string safe to ship with an event:
 * the IPC wrapper prefix is dropped, home directories become `~`, other
 * absolute paths become `<path>`, URL queries are dropped, whitespace is
 * collapsed, and the result is capped at DSH_ANALYTICS_ERROR_DETAIL_MAX_LENGTH.
 */
export function sanitizeDshErrorDetail(error: unknown): string {
  let detail = errorMessage(error)
    .replace(IPC_ERROR_PREFIX_PATTERN, '')
    .replace(URL_QUERY_PATTERN, '$1')
    .replace(WINDOWS_HOME_PATTERN, HOME_PLACEHOLDER)
    .replace(POSIX_HOME_PATTERN, HOME_PLACEHOLDER)
    .replace(WINDOWS_PATH_PATTERN, PATH_PLACEHOLDER)
    .replace(POSIX_PATH_PATTERN, PATH_PLACEHOLDER)
    .replace(/\s+/g, ' ')
    .trim();
  if (detail.length > DSH_ANALYTICS_ERROR_DETAIL_MAX_LENGTH) {
    detail = `${detail.slice(0, DSH_ANALYTICS_ERROR_DETAIL_MAX_LENGTH - 1)}…`;
  }
  return detail;
}

/** Null when nothing changed, so a repeated toggle to the same value is not counted. */
export function buildDshEnabledChangedEvent(previous: boolean, next: boolean): LogEventParams | null {
  if (previous === next) return null;
  return {
    action: LogReporterAction.ExperimentalSettingChanged,
    settingKey: DshAnalyticsSettingKey.Enabled,
    settingValue: next,
    previousValue: previous,
    source: LogReporterSource.SettingsExperimental,
  };
}

export interface DshEngineStateForAnalytics {
  phase: DshEnginePhase | string;
  errorCode: DshEngineErrorCode | string | null;
}

/**
 * Picks the failure class for a failed workbench open. The engine's own code
 * is trusted only in its terminal phases; in any other phase the field is
 * either null or left over from an earlier run. The main process rejects an
 * open while the feature is off with a fixed message, which maps to
 * `not_enabled` without any engine state.
 */
export function resolveDshOpenWorkbenchErrorCode(
  state: DshEngineStateForAnalytics | null,
  error: unknown,
): string {
  if (errorMessage(error).includes(NOT_ENABLED_MESSAGE_FRAGMENT)) {
    return DshAnalyticsErrorCode.NotEnabled;
  }
  if (state && (state.phase === DshEnginePhase.Failed || state.phase === DshEnginePhase.NotInstalled)) {
    return state.errorCode ?? DshAnalyticsErrorCode.Unknown;
  }
  return DshAnalyticsErrorCode.Unknown;
}

export interface DshOpenWorkbenchEventInput {
  /** Engine phase when the user clicked, before any install/start ran. */
  phaseBefore: string;
  result: DshAnalyticsResult;
  /** Failure class; defaults to `unknown` for failed results. */
  errorCode?: string;
  /** Raw error; only a masked, truncated form of its message is reported. */
  error?: unknown;
}

export function buildDshOpenWorkbenchEvent(input: DshOpenWorkbenchEventInput): LogEventParams {
  const failed = input.result === DshAnalyticsResult.Failed;
  const errorDetail = failed && input.error !== undefined ? sanitizeDshErrorDetail(input.error) : '';
  return {
    action: LogReporterAction.DshAction,
    actionType: DshAnalyticsActionType.OpenWorkbench,
    source: LogReporterSource.SettingsExperimental,
    phaseBefore: input.phaseBefore,
    result: input.result,
    errorCode: failed ? (input.errorCode ?? DshAnalyticsErrorCode.Unknown) : undefined,
    errorDetail: errorDetail || undefined,
  };
}

export function reportDshEnabledChanged(previous: boolean, next: boolean): void {
  const params = buildDshEnabledChangedEvent(previous, next);
  if (params) void reportYdAnalyzer(params);
}

export function reportDshOpenWorkbench(input: DshOpenWorkbenchEventInput): void {
  void reportYdAnalyzer(buildDshOpenWorkbenchEvent(input));
}
