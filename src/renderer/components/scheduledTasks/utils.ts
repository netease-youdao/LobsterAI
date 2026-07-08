import cronstrue from 'cronstrue/i18n';

import type {
  Schedule,
  ScheduleCron,
  ScheduledTask,
  ScheduledTaskChannelOption,
  ScheduledTaskConversationOption,
  ScheduledTaskDelivery,
  ScheduledTaskPayload,
} from '../../../scheduledTask/types';
import {
  imConversationDisplayName,
  ImPeerKind,
  parseImConversationId,
  PlatformRegistry,
} from '../../../shared/platform';
import { i18nService } from '../../services/i18n';

const WEEKDAY_KEYS = [
  'scheduledTasksFormWeekSun',
  'scheduledTasksFormWeekMon',
  'scheduledTasksFormWeekTue',
  'scheduledTasksFormWeekWed',
  'scheduledTasksFormWeekThu',
  'scheduledTasksFormWeekFri',
  'scheduledTasksFormWeekSat',
] as const;

/**
 * Pad a number to 2 digits, e.g. 5 → "05".
 */
function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Simple template: replace `{key}` placeholders with values.
 */
function tpl(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

type ParsedField =
  | { type: 'any' }
  | { type: 'value'; value: number }
  | { type: 'step'; step: number }
  | { type: 'range'; from: number; to: number }
  | { type: 'list'; values: number[] };

/**
 * Parse a single cron field: '*', a number, a step ('*&#47;n'), a range ('from-to'),
 * or a comma-separated list of numbers ('0,6').
 * Returns null if the field uses unsupported syntax.
 */
function parseField(field: string): ParsedField | null {
  if (field === '*') return { type: 'any' };
  if (/^\d+$/.test(field)) return { type: 'value', value: Number(field) };
  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) return { type: 'step', step: Number(stepMatch[1]) };
  const rangeMatch = field.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) return { type: 'range', from: Number(rangeMatch[1]), to: Number(rangeMatch[2]) };
  if (/^\d+(?:,\d+)+$/.test(field)) {
    return { type: 'list', values: field.split(',').map(Number) };
  }
  return null;
}

/**
 * Parse a comma-separated list of numbers (e.g. "1,3,5").
 * Returns sorted array of numbers, or null if the field is not a simple comma list.
 */
function parseCommaSeparated(field: string): number[] | null {
  if (!/^\d+(,\d+)*$/.test(field)) return null;
  const values = field.split(',').map(Number);
  if (values.some(v => Number.isNaN(v))) return null;
  return [...values].sort((a, b) => a - b);
}

/**
 * Convert a standard 5-field cron expression into a human-readable i18n string.
 * Handles common patterns; falls back to "Cron · expr" for complex expressions.
 */
function formatCronExpr(schedule: ScheduleCron): string {
  const parts = schedule.expr.trim().split(/\s+/);
  if (parts.length !== 5) return fallbackCron(schedule);

  const [minRaw, hourRaw, domRaw, monRaw, dowRaw] = parts;
  const min = parseField(minRaw);
  const hour = parseField(hourRaw);
  const dom = parseField(domRaw);
  const mon = parseField(monRaw);
  const dow = parseField(dowRaw);

  // If any core field is unparseable, fall back (dow can be null for comma-separated)
  if (!min || !hour || !dom || !mon) return fallbackCron(schedule);

  // --- Every N minutes: */n * * * * ---
  if (
    min.type === 'step' &&
    hour.type === 'any' &&
    dom.type === 'any' &&
    mon.type === 'any' &&
    dow?.type === 'any'
  ) {
    if (min.step === 1) return i18nService.t('scheduledTasksCronEveryMinute');
    return tpl(i18nService.t('scheduledTasksCronEveryNMinutes'), { n: String(min.step) });
  }

  // --- Every N hours: fixed-min */n * * * ---
  if (
    min.type === 'value' &&
    hour.type === 'step' &&
    dom.type === 'any' &&
    mon.type === 'any' &&
    dow?.type === 'any'
  ) {
    if (hour.step === 1) return i18nService.t('scheduledTasksCronEveryHour');
    return tpl(i18nService.t('scheduledTasksCronEveryNHours'), { n: String(hour.step) });
  }

  // --- Every hour at fixed minute: M * * * * (e.g. 25 * * * *) ---
  if (
    min.type === 'value' &&
    hour.type === 'any' &&
    dom.type === 'any' &&
    mon.type === 'any' &&
    dow?.type === 'any'
  ) {
    return tpl(i18nService.t('scheduledTasksCronEveryHourAtMinute'), { min: pad2(min.value) });
  }

  // From here we need a fixed time (both minute and hour are concrete values)
  if (min.type !== 'value' || hour.type !== 'value') return fallbackCron(schedule);
  const time = `${pad2(hour.value)}:${pad2(min.value)}`;

  // --- Every day: M H * * * ---
  if (dom.type === 'any' && mon.type === 'any' && dow?.type === 'any') {
    return tpl(i18nService.t('scheduledTasksCronAtTime'), {
      schedule: i18nService.t('scheduledTasksCronEveryDay'),
      time,
    });
  }

  // --- Specific day-of-week: M H * * dow ---
  if (dom.type === 'any' && mon.type === 'any') {
    if (dow) {
      // Weekdays 1-5
      if (dow.type === 'range' && dow.from === 1 && dow.to === 5) {
        return tpl(i18nService.t('scheduledTasksCronAtTime'), {
          schedule: i18nService.t('scheduledTasksCronWeekdays'),
          time,
        });
      }
      // Weekends 0,6 or 6-0
      if (
        dow.type === 'range' &&
        ((dow.from === 6 && dow.to === 0) || (dow.from === 0 && dow.to === 6))
      ) {
        return tpl(i18nService.t('scheduledTasksCronAtTime'), {
          schedule: i18nService.t('scheduledTasksCronWeekends'),
          time,
        });
      }
      // Single weekday: M H * * 3
      if (dow.type === 'value' && dow.value >= 0 && dow.value <= 6) {
        const dayName = i18nService.t(WEEKDAY_KEYS[dow.value]);
        return tpl(i18nService.t('scheduledTasksCronAtTime'), {
          schedule: `${i18nService.t('scheduledTasksCronEveryWeek')}${dayName}`,
          time,
        });
      }
      // Weekday range (e.g. 1-3)
      if (dow.type === 'range' && dow.from >= 0 && dow.from <= 6 && dow.to >= 0 && dow.to <= 6) {
        const fromName = i18nService.t(WEEKDAY_KEYS[dow.from]);
        const toName = i18nService.t(WEEKDAY_KEYS[dow.to]);
        return tpl(i18nService.t('scheduledTasksCronAtTime'), {
          schedule: `${fromName}-${toName}`,
          time,
        });
      }
    } else {
      // Comma-separated weekdays: M H * * 1,3,5
      const days = parseCommaSeparated(dowRaw);
      if (days && days.length > 0 && days.every(d => d >= 0 && d <= 6)) {
        if (days.join(',') === '1,2,3,4,5') {
          return tpl(i18nService.t('scheduledTasksCronAtTime'), {
            schedule: i18nService.t('scheduledTasksCronWeekdays'),
            time,
          });
        }
        const separator = i18nService.getLanguage() === 'zh' ? '、' : ', ';
        const sortedDays =
          i18nService.getLanguage() === 'zh' ? [...days].sort((a, b) => (a || 7) - (b || 7)) : days;
        const dayNames = sortedDays.map(d => i18nService.t(WEEKDAY_KEYS[d]));
        return tpl(i18nService.t('scheduledTasksCronAtTime'), {
          schedule: `${i18nService.t('scheduledTasksCronEveryWeek')}${dayNames.join(separator)}`,
          time,
        });
      }
    }
  }

  // --- Monthly on specific day: M H dom * * ---
  if (dom.type === 'value' && mon.type === 'any' && dow?.type === 'any') {
    return tpl(i18nService.t('scheduledTasksCronAtMonthDay'), {
      schedule: i18nService.t('scheduledTasksCronEveryMonth'),
      day: String(dom.value),
      time,
    });
  }

  return fallbackCron(schedule);
}

function fallbackCron(schedule: ScheduleCron): string {
  const tzLabel = schedule.tz ? ` (${schedule.tz})` : '';
  try {
    const locale = i18nService.getLanguage() === 'zh' ? 'zh_CN' : 'en';
    const desc = cronstrue.toString(schedule.expr, { locale, use24HourTimeFormat: true });
    return `${desc}${tzLabel}`;
  } catch {
    return `Cron · ${schedule.expr}${tzLabel}`;
  }
}

export function formatScheduleLabel(schedule: Schedule): string {
  if (schedule.kind === 'at') {
    const date = new Date(schedule.at);
    if (Number.isFinite(date.getTime())) {
      return `${i18nService.t('scheduledTasksFormScheduleModeAt')} · ${formatDateTime(date)}`;
    }
    return i18nService.t('scheduledTasksFormScheduleModeAt');
  }

  if (schedule.kind === 'every') {
    const everyMs = schedule.everyMs;
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      return `${i18nService.t('scheduledTasksScheduleEvery')} -`;
    }
    if (everyMs % 86_400_000 === 0) {
      return `${i18nService.t('scheduledTasksScheduleEvery')} ${everyMs / 86_400_000} ${i18nService.t('scheduledTasksFormIntervalDays')}`;
    }
    if (everyMs % 3_600_000 === 0) {
      return `${i18nService.t('scheduledTasksScheduleEvery')} ${everyMs / 3_600_000} ${i18nService.t('scheduledTasksFormIntervalHours')}`;
    }
    return `${i18nService.t('scheduledTasksScheduleEvery')} ${Math.max(1, Math.round(everyMs / 60_000))} ${i18nService.t('scheduledTasksFormIntervalMinutes')}`;
  }

  return formatCronExpr(schedule);
}

/**
 * Locale-aware date-time formatting.
 * Chinese → 24-hour clock; English → 12-hour clock with AM/PM.
 */
export function formatDateTime(date: Date): string {
  const lang = i18nService.getLanguage();
  if (lang === 'zh') {
    return date.toLocaleString('zh-CN', { hour12: false });
  }
  return date.toLocaleString('en-US');
}

/**
 * Minute-precision date-time for schedule labels (last/next run). Seconds are
 * dropped: they are noise for schedules and belong only in run-history rows.
 */
export function formatDateTimeMinute(date: Date): string {
  const lang = i18nService.getLanguage();
  if (lang === 'zh') {
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * Live elapsed-time label for a running task, e.g. "42s", "3m 12s", "1h 05m".
 */
export function formatElapsedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Remove the machine-routing "[cron:<id> <name>]" prefix that OpenClaw
 * prepends to cron prompts before they reach the agent. Display-only.
 */
export function stripCronMetadataPrefix(text: string): string {
  return text.replace(/^\s*\[cron:[^\]\n]*\]\s*/, '');
}

/**
 * Format a future timestamp as a relative "time until" string.
 * e.g. "5 分钟后" / "2 小时后" / "3 天后" (zh) or "in 5 min" / "in 2 h" / "in 3 d" (en)
 * Returns null if nextRunAtMs is null or in the past.
 */
export function formatNextRunRelative(nextRunAtMs: number | null): string | null {
  if (nextRunAtMs === null) return null;
  const diffMs = nextRunAtMs - Date.now();
  if (diffMs <= 0) return null;

  const lang = i18nService.getLanguage();
  const isChinese = lang === 'zh';

  const minutes = Math.round(diffMs / 60_000);
  const hours = Math.round(diffMs / 3_600_000);
  const days = Math.round(diffMs / 86_400_000);

  if (diffMs < 60_000) {
    return isChinese ? '不到 1 分钟后' : 'in < 1 min';
  }
  if (diffMs < 3_600_000) {
    return isChinese ? `${minutes} 分钟后` : `in ${minutes} min`;
  }
  if (diffMs < 86_400_000) {
    return isChinese ? `${hours} 小时后` : `in ${hours} h`;
  }
  return isChinese ? `${days} 天后` : `in ${days} d`;
}

export function formatPayloadLabel(payload: ScheduledTaskPayload): string {
  if (payload.kind === 'systemEvent') {
    return `${i18nService.t('scheduledTasksFormPayloadKindSystemEvent')} · ${payload.text}`;
  }
  const timeoutLabel =
    typeof payload.timeoutSeconds === 'number' ? ` · ${payload.timeoutSeconds}s` : '';
  return `${i18nService.t('scheduledTasksFormPayloadKindAgentTurn')} · ${payload.message}${timeoutLabel}`;
}

/**
 * Resolve a channel name to a user-friendly display name via i18n + PlatformRegistry.
 * e.g. 'feishu' → '飞书', 'openclaw-weixin' → '微信', 'moltbot-popo' → 'POPO'
 */
function resolveChannelDisplayName(channel: string): string {
  const platform = PlatformRegistry.platformOfChannel(channel);
  if (platform) {
    return i18nService.t(platform) || PlatformRegistry.get(platform).label;
  }
  return channel;
}

/** Localized label for a conversation peer kind ('direct' → 私聊/DM). */
function conversationPeerKindLabel(peerKind: string | undefined): string {
  switch (peerKind) {
    case ImPeerKind.Direct:
      return i18nService.t('scheduledTasksConvKindDirect');
    case ImPeerKind.Group:
      return i18nService.t('scheduledTasksConvKindGroup');
    case ImPeerKind.Channel:
      return i18nService.t('scheduledTasksConvKindChannel');
    default:
      return '';
  }
}

/** Dropdown label for a conversation option, e.g. "私聊 · 张三" instead of raw IDs. */
export function formatConversationOptionLabel(option: ScheduledTaskConversationOption): string {
  const name = option.displayName?.trim() || imConversationDisplayName(option.conversationId);
  const kind = conversationPeerKindLabel(
    option.peerKind ?? parseImConversationId(option.conversationId).peerKind,
  );
  return kind ? `${kind} · ${name}` : name;
}

/** Friendly rendering of a saved delivery target (bare peer id or full conversation id). */
export function formatDeliveryTarget(to: string): string {
  const kind = conversationPeerKindLabel(parseImConversationId(to).peerKind);
  const name = imConversationDisplayName(to);
  return kind ? `${kind} · ${name}` : name;
}

/**
 * Default notify target for a bot instance: the most recent direct (DM)
 * conversation, falling back to the most recent conversation of any kind.
 * The input list is already sorted by recency (listSessionMappings orders by
 * last_active_at DESC).
 */
export function pickDefaultConversation(
  conversations: readonly ScheduledTaskConversationOption[],
): ScheduledTaskConversationOption | undefined {
  if (conversations.length === 0) return undefined;
  const direct = conversations.find(
    conv =>
      (conv.peerKind ?? parseImConversationId(conv.conversationId).peerKind) === ImPeerKind.Direct,
  );
  return direct ?? conversations[0];
}

/**
 * Whether a conversation option refers to a saved delivery target. Saved targets
 * are normalized to the bare peer id at create time (see
 * applyAnnounceDeliveryNormalization), so options also match by their peer id
 * or trailing segment.
 */
export function conversationOptionMatchesValue(
  channel: string,
  optionConversationId: string,
  selectedValue: string,
): boolean {
  // Compare case-insensitively: conversation ids derive from lowercased
  // OpenClaw session keys, while saved delivery targets are restored to the
  // channel-native casing at save time (see applyAnnounceDeliveryNormalization).
  const optionId = optionConversationId.trim().toLowerCase();
  const value = selectedValue.trim().toLowerCase();
  if (!optionId || !value) return false;
  if (optionId === value) return true;
  if (parseImConversationId(optionId).peerId === value) return true;
  if (optionId.endsWith(`:${value}`)) return true;

  const platform = PlatformRegistry.platformOfChannel(channel);
  if (platform === 'nim' && optionId.endsWith(`|${value}`)) return true;

  return false;
}

/**
 * Whether a channel option corresponds to the selected channel/account pair.
 * Single-instance options carry no accountId and match regardless of the
 * saved delivery accountId, which save-time normalization may stamp with the
 * bot account owning the target conversation.
 */
export function channelOptionMatchesSelection(
  option: ScheduledTaskChannelOption,
  channelValue: string,
  accountId: string | undefined,
): boolean {
  if (option.value !== channelValue) return false;
  return option.accountId ? option.accountId === accountId : true;
}

/**
 * Display label for a channel option. Multi-instance platforms get a
 * "平台 · 实例名" suffix only when more than one instance of that platform is
 * present; unnamed instances fall back to an ordinal instead of an account id.
 */
export function formatChannelOptionLabel(
  option: ScheduledTaskChannelOption,
  allOptions: readonly ScheduledTaskChannelOption[],
): string {
  const platform = PlatformRegistry.platformOfChannel(option.value);
  const platformLabel = platform
    ? i18nService.t(platform) || PlatformRegistry.get(platform).label
    : option.label || option.value;
  if (!option.accountId) return platformLabel;

  const siblings = allOptions.filter(o => o.value === option.value && o.accountId);
  if (siblings.length <= 1) return platformLabel;

  const ordinal = siblings.findIndex(o => o.accountId === option.accountId) + 1;
  const instanceName =
    option.label.trim() || `${i18nService.t('scheduledTasksFormInstanceFallback')} ${ordinal}`;
  return `${platformLabel} · ${instanceName}`;
}

/**
 * Resolve a saved delivery target against known conversations so the label
 * shows the human-friendly name ("私聊 · 张三") instead of the raw peer id.
 */
function resolveDeliveryTargetLabel(
  channel: string,
  to: string,
  conversations?: readonly ScheduledTaskConversationOption[],
): string {
  const match = conversations?.find(option =>
    conversationOptionMatchesValue(channel, option.conversationId, to),
  );
  return match ? formatConversationOptionLabel(match) : formatDeliveryTarget(to);
}

/**
 * Channel label matching the form picker: platform name plus the instance
 * name when several instances of that platform exist ("企业微信 · 2 号").
 */
function resolveDeliveryChannelLabel(
  channel: string,
  accountId: string | undefined,
  channels?: readonly ScheduledTaskChannelOption[],
): string {
  if (channels) {
    const match = channels.find(option =>
      channelOptionMatchesSelection(option, channel, accountId),
    );
    if (match) return formatChannelOptionLabel(match, channels);
  }
  return resolveChannelDisplayName(channel);
}

/** Option lists (as loaded for the form pickers) used to prettify labels. */
export interface DeliveryLabelContext {
  conversations?: readonly ScheduledTaskConversationOption[];
  channels?: readonly ScheduledTaskChannelOption[];
}

export function formatDeliveryLabel(
  delivery: ScheduledTaskDelivery,
  context: DeliveryLabelContext = {},
): string {
  if (delivery.mode === 'webhook') {
    return delivery.to
      ? `${i18nService.t('scheduledTasksFormDeliveryModeWebhook')} · ${delivery.to}`
      : i18nService.t('scheduledTasksFormDeliveryModeWebhook');
  }

  if (!delivery.channel) {
    return delivery.mode === 'none'
      ? i18nService.t('scheduledTasksFormDeliveryModeNone')
      : i18nService.t('scheduledTasksFormDeliveryModeAnnounce');
  }

  // Mirror the form picker wording ("channel instance · conversation"); the
  // internal announce/none delivery mode is jargon to end users.
  const channelName = resolveDeliveryChannelLabel(
    delivery.channel,
    delivery.accountId,
    context.channels,
  );
  const toLabel = delivery.to
    ? ` · ${resolveDeliveryTargetLabel(delivery.channel, delivery.to, context.conversations)}`
    : '';
  return `${channelName}${toLabel}`;
}

export type PlanType = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron' | 'advanced';

export interface PlanInfo {
  planType: PlanType;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  weekdays: number[];
  monthDay: number;
  year: number;
  month: number;
  day: number;
  cronExpr?: string;
  cronTz?: string;
}

const DEFAULT_PLAN_INFO: PlanInfo = {
  planType: 'daily',
  hour: 9,
  minute: 0,
  second: 0,
  weekday: 1,
  weekdays: [1],
  monthDay: 1,
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  day: new Date().getDate(),
};

export function scheduleToPlanInfo(schedule: Schedule): PlanInfo {
  if (schedule.kind === 'at') {
    const date = new Date(schedule.at);
    if (!Number.isFinite(date.getTime())) return { ...DEFAULT_PLAN_INFO, planType: 'once' };
    return {
      planType: 'once',
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      weekday: DEFAULT_PLAN_INFO.weekday,
      weekdays: DEFAULT_PLAN_INFO.weekdays,
      monthDay: DEFAULT_PLAN_INFO.monthDay,
    };
  }

  if (schedule.kind === 'every') {
    return { ...DEFAULT_PLAN_INFO, planType: 'advanced' };
  }

  const parts = schedule.expr.trim().split(/\s+/);
  if (parts.length !== 5) return { ...DEFAULT_PLAN_INFO, planType: 'advanced' };

  const [minRaw, hourRaw, domRaw, , dowRaw] = parts;
  const min = parseField(minRaw);
  const hour = parseField(hourRaw);
  const dom = parseField(domRaw);
  const dow = parseField(dowRaw);

  if (!min || min.type !== 'value') {
    return { ...DEFAULT_PLAN_INFO, planType: 'advanced' };
  }

  // Hourly: M * * * *
  if (hour && hour.type === 'any' && dom && dom.type === 'any') {
    return { ...DEFAULT_PLAN_INFO, planType: 'hourly', minute: min.value };
  }

  if (!hour || hour.type !== 'value') {
    return { ...DEFAULT_PLAN_INFO, planType: 'advanced' };
  }

  const base: PlanInfo = {
    ...DEFAULT_PLAN_INFO,
    hour: hour.value,
    minute: min.value,
  };

  // Daily: M H * * *
  if (dom && dom.type === 'any' && dow && dow.type === 'any') {
    return { ...base, planType: 'daily' };
  }

  // Weekly: M H * * DOW (single value)
  if (
    dom &&
    dom.type === 'any' &&
    dow &&
    dow.type === 'value' &&
    dow.value >= 0 &&
    dow.value <= 6
  ) {
    return { ...base, planType: 'weekly', weekday: dow.value, weekdays: [dow.value] };
  }

  // Weekly: M H * * DOW,DOW,... (comma-separated)
  if (dom && dom.type === 'any' && dow && dow.type === 'list') {
    const days = [...new Set(dow.values)].sort((a, b) => a - b);
    if (days.length > 0 && days.every(d => d >= 0 && d <= 6)) {
      return { ...base, planType: 'weekly', weekday: days[0], weekdays: days };
    }
  }

  // Weekly: M H * * DOW,DOW,... (fallback for unsupported comma syntax)
  if (dom && dom.type === 'any' && dow === null) {
    const days = parseCommaSeparated(dowRaw);
    if (days && days.length > 0 && days.every(d => d >= 0 && d <= 6)) {
      return { ...base, planType: 'weekly', weekday: days[0], weekdays: days };
    }
  }

  // Monthly: M H DOM * *
  if (dom && dom.type === 'value' && dow && dow.type === 'any') {
    return { ...base, planType: 'monthly', monthDay: dom.value };
  }

  return { ...DEFAULT_PLAN_INFO, planType: 'cron', cronExpr: schedule.expr, cronTz: schedule.tz };
}

export function getTaskPromptText(task: ScheduledTask): string {
  return task.payload.kind === 'systemEvent' ? task.payload.text : task.payload.message;
}

/**
 * User-facing task status combining the enable switch, the live running
 * flag, and the last run result into one unambiguous label.
 */
export const TaskDisplayStatus = {
  Running: 'running',
  Paused: 'paused',
  Success: 'success',
  Error: 'error',
  Skipped: 'skipped',
  Never: 'never',
} as const;
export type TaskDisplayStatus = typeof TaskDisplayStatus[keyof typeof TaskDisplayStatus];

export function getTaskDisplayStatus(task: ScheduledTask): TaskDisplayStatus {
  const { state } = task;
  if (state.runningAtMs || state.lastStatus === 'running') return TaskDisplayStatus.Running;
  if (!task.enabled) return TaskDisplayStatus.Paused;
  if (state.lastStatus === 'success') return TaskDisplayStatus.Success;
  if (state.lastStatus === 'error') return TaskDisplayStatus.Error;
  if (state.lastStatus === 'skipped') return TaskDisplayStatus.Skipped;
  return TaskDisplayStatus.Never;
}

export const taskDisplayStatusLabelKey: Record<TaskDisplayStatus, string> = {
  [TaskDisplayStatus.Running]: 'scheduledTasksStatusRunning',
  [TaskDisplayStatus.Paused]: 'scheduledTasksStatusPaused',
  [TaskDisplayStatus.Success]: 'scheduledTasksStatusSuccess',
  [TaskDisplayStatus.Error]: 'scheduledTasksStatusError',
  [TaskDisplayStatus.Skipped]: 'scheduledTasksStatusSkipped',
  [TaskDisplayStatus.Never]: 'scheduledTasksStatusNever',
};
