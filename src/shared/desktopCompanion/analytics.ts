import { LogReporterAction } from '../analytics/constants';
import { isUsageId } from '../analytics/usage';
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
