import { LogReporterAction } from '../analytics/constants';
import { isUsageId, UsageFailureCode, usageFailureCode } from '../analytics/usage';
import { OpenClawEnginePhase } from '../openclawEngine/constants';
import { CompanionAppCategory } from './appCategories';
import { DesktopCompanionSnoozeMode, DesktopCompanionSurface } from './constants';
import { CompanionDropAction, CompanionFileKind } from './fileKinds';
import { COMPANION_WELCOME_TOPIC, CompanionHintOutcome, type CompanionHintTopic } from './hintPolicy';
import { LanguageTool, LanguageToolCode } from './languageTools';
import { CompanionSelectionAction } from './selectionActions';
import { COMPANION_SKINS } from './skins';

export const CompanionAnalyticsAction = {
  Action: LogReporterAction.DesktopCompanionAction,
  SettingChanged: LogReporterAction.DesktopCompanionSettingChanged,
  Task: LogReporterAction.DesktopCompanionTask,
  Tool: LogReporterAction.DesktopCompanionTool,
  Hint: LogReporterAction.DesktopCompanionHint,
  FileDrop: LogReporterAction.DesktopCompanionFileDrop,
} as const;

export const CompanionAnalyticsSource = {
  Orb: 'orb', Shortcut: 'shortcut', Tray: 'tray', ContextMenu: 'context_menu',
  Panel: 'panel', Selection: 'selection', LanguageTools: 'language_tools',
  Result: 'result', FileDrop: 'file_drop', Hint: 'hint', Settings: 'settings', System: 'system',
} as const;
export type CompanionAnalyticsSource = typeof CompanionAnalyticsSource[keyof typeof CompanionAnalyticsSource];

export const CompanionAnalyticsInteraction = {
  Click: 'click', Open: 'open', Close: 'close', OpenMain: 'open_main', OpenSettings: 'open_settings',
  OpenSkills: 'open_skills', OpenKits: 'open_kits', ContextMenu: 'context_menu', Copy: 'copy', Pin: 'pin',
  Pause: 'pause', Resume: 'resume', Stop: 'stop', Dismiss: 'dismiss', ExcludeApp: 'exclude_app',
  More: 'more', Permission: 'permission', LoginShown: 'login_shown', Run: 'run',
} as const;

export const CompanionAnalyticsStage = { Shown: 'shown', Submit: 'submit', Result: 'result' } as const;
export const CompanionAnalyticsOutcome = {
  Success: 'success', Failed: 'failed', Cancelled: 'cancelled', Blocked: 'blocked',
} as const;
export type CompanionAnalyticsOutcome = typeof CompanionAnalyticsOutcome[keyof typeof CompanionAnalyticsOutcome];
export const CompanionAnalyticsTool = { ...CompanionSelectionAction, ...LanguageTool, Screenshot: 'screenshot' } as const;
export const CompanionAnalyticsSetting = {
  Enabled: 'enabled', Shortcut: 'shortcut', Skin: 'skin', SelectionToolbar: 'selectionToolbar',
  DragAssist: 'dragAssist', ContextHints: 'contextHints', ExcludedApps: 'selectionExcludedApps',
  ToolbarOrder: 'selectionToolbarOrder',
} as const;
export const CompanionAnalyticsReason = {
  LoginRequired: 'login_required', NoModel: 'no_model', InvalidInput: 'invalid_input',
  Unavailable: 'unavailable', Limit: 'limit', Upstream: 'upstream',
} as const;

/** Reuse configured rlog columns; bounded values contain no prompts, paths or raw errors. */
export const CompanionTaskFailureCode = {
  ...UsageFailureCode,
  NoModel: 'no_model', ModelBillingSide: 'model_billing_side',
  WorkingDirectory: 'working_directory', PayloadPreparation: 'payload_preparation',
} as const;
export const CompanionTaskFailureStage = {
  Preflight: 'preflight', Prepare: 'prepare', SessionStart: 'session_start',
  SessionLookup: 'session_lookup', SessionStop: 'session_stop', SessionContinue: 'session_continue',
} as const;
export type CompanionTaskFailureStage = typeof CompanionTaskFailureStage[keyof typeof CompanionTaskFailureStage];
export const CompanionTaskBlockedReason = {
  ...OpenClawEnginePhase,
  Unknown: 'unknown', EnterpriseQuota: 'enterprise_quota', ModelBillingSide: 'model_billing_side', NoModel: 'no_model',
} as const;

export interface CompanionTaskFailure {
  failureCode: ValueOf<typeof CompanionTaskFailureCode>;
  failureStage: CompanionTaskFailureStage;
  blockedReason?: ValueOf<typeof CompanionTaskBlockedReason>;
}

/** Prefer structured IPC codes and retain a bounded gateway phase for readiness races. */
export function companionTaskFailure(error: unknown, failureStage: CompanionTaskFailureStage): CompanionTaskFailure {
  const response = error && typeof error === 'object' && !(error instanceof Error)
    ? error as { code?: unknown; error?: unknown; engineStatus?: { phase?: unknown } } : undefined;
  const code = response?.code;
  const knownCode = Object.values(CompanionTaskFailureCode).find(value => value === code);
  const failureCode = knownCode ?? usageFailureCode(code ?? response?.error ?? error);
  const phase = response?.engineStatus?.phase;
  return { failureCode, failureStage,
    ...(failureCode === CompanionTaskFailureCode.EngineNotReady ? { blockedReason:
      Object.values(OpenClawEnginePhase).find(value => value === phase) ?? CompanionTaskBlockedReason.Unknown } : {}) };
}

type ValueOf<T> = T[keyof T];
export interface CompanionAnalyticsEvent {
  action: ValueOf<typeof CompanionAnalyticsAction>;
  source: CompanionAnalyticsSource;
  interactionType?: ValueOf<typeof CompanionAnalyticsInteraction>;
  stage?: ValueOf<typeof CompanionAnalyticsStage>;
  outcome?: CompanionAnalyticsOutcome | CompanionHintOutcome;
  surface?: DesktopCompanionSurface;
  tool?: ValueOf<typeof CompanionAnalyticsTool>;
  setting?: ValueOf<typeof CompanionAnalyticsSetting>;
  reason?: ValueOf<typeof CompanionAnalyticsReason>;
  failureCode?: CompanionTaskFailure['failureCode'];
  failureStage?: CompanionTaskFailureStage;
  blockedReason?: CompanionTaskFailure['blockedReason'];
  topic?: CompanionHintTopic;
  dropAction?: CompanionDropAction;
  snoozeMode?: DesktopCompanionSnoozeMode;
  skin?: string;
  enabled?: boolean;
  hasShortcut?: boolean;
  hasSession?: boolean;
  isFollowUp?: boolean;
  pinned?: boolean;
  attachmentCount?: number;
  excludedAppCount?: number;
  recentTaskCount?: number;
  durationMs?: number;
  fileKinds?: string;
  callId?: string;
  journeyId?: string;
  taskId?: string;
  turnId?: string;
}

const enumFields = {
  action: Object.values(CompanionAnalyticsAction), source: Object.values(CompanionAnalyticsSource),
  interactionType: Object.values(CompanionAnalyticsInteraction), stage: Object.values(CompanionAnalyticsStage),
  outcome: [...Object.values(CompanionAnalyticsOutcome), ...Object.values(CompanionHintOutcome)],
  surface: Object.values(DesktopCompanionSurface), tool: Object.values(CompanionAnalyticsTool),
  setting: Object.values(CompanionAnalyticsSetting), reason: Object.values(CompanionAnalyticsReason),
  failureCode: Object.values(CompanionTaskFailureCode), failureStage: Object.values(CompanionTaskFailureStage),
  blockedReason: Object.values(CompanionTaskBlockedReason),
  topic: [COMPANION_WELCOME_TOPIC, ...Object.values(CompanionAppCategory)], dropAction: Object.values(CompanionDropAction),
  snoozeMode: Object.values(DesktopCompanionSnoozeMode), skin: COMPANION_SKINS.map(skin => skin.id),
};

/** One allowlist for native events and renderer IPC: never forward business payloads. */
export function normalizeCompanionAnalyticsEvent(input: unknown): CompanionAnalyticsEvent | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const event: Record<string, string | number | boolean> = {};
  for (const [key, values] of Object.entries(enumFields)) {
    if (typeof value[key] === 'string' && (values as readonly string[]).includes(value[key])) event[key] = value[key];
  }
  if (!event.action || !event.source) return null;
  for (const key of ['callId', 'journeyId', 'taskId', 'turnId']) {
    if (isUsageId(value[key])) event[key] = value[key];
  }
  for (const key of ['enabled', 'hasShortcut', 'hasSession', 'isFollowUp', 'pinned']) {
    if (typeof value[key] === 'boolean') event[key] = value[key];
  }
  for (const key of ['attachmentCount', 'excludedAppCount', 'recentTaskCount', 'durationMs']) {
    if (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0) event[key] = value[key];
  }
  if (typeof value.fileKinds === 'string') {
    const kinds = [...new Set(value.fileKinds.split(',').filter(kind => Object.values(CompanionFileKind).includes(kind as CompanionFileKind)))];
    if (kinds.length) event.fileKinds = kinds.join(',');
  }
  return event as unknown as CompanionAnalyticsEvent;
}

export function companionLanguageErrorReason(code?: number): ValueOf<typeof CompanionAnalyticsReason> {
  if (code === LanguageToolCode.Unauthorized) return CompanionAnalyticsReason.LoginRequired;
  if (code === LanguageToolCode.DailyLimit || code === LanguageToolCode.RateLimit || code === LanguageToolCode.TooLong) return CompanionAnalyticsReason.Limit;
  if (code === LanguageToolCode.InvalidInput || code === LanguageToolCode.Duplicate) return CompanionAnalyticsReason.InvalidInput;
  if (code === LanguageToolCode.Upstream) return CompanionAnalyticsReason.Upstream;
  return CompanionAnalyticsReason.Unavailable;
}
