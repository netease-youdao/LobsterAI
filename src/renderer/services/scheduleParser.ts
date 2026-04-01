import { CronExpressionParser } from 'cron-parser';
import { apiService } from './api';
import { i18nService } from './i18n';

export interface ParseScheduleResultCron {
  kind: 'cron';
  cronExpr: string;
}

export interface ParseScheduleResultAt {
  kind: 'at';
  at: string;
}

export type ParseScheduleResult = ParseScheduleResultCron | ParseScheduleResultAt;

export interface ParseScheduleError {
  error: string;
}

export type ParseScheduleOutcome = ParseScheduleResult | ParseScheduleError;

export function isParseError(outcome: ParseScheduleOutcome): outcome is ParseScheduleError {
  return 'error' in outcome;
}

export async function parseSchedule(description: string): Promise<ParseScheduleOutcome> {
  const trimmed = description.trim();
  if (!trimmed) {
    return { error: i18nService.t('scheduleParserEmptyInput') };
  }

  const now = new Date();
  const nowStr = now.toLocaleString('zh-CN', { hour12: false });

  const systemPrompt = `You are a schedule expression generator. The current local time is: ${nowStr}.

Convert the user's natural language schedule description into one of two formats:

1. For RECURRING schedules → output: CRON: <5-field cron expression>
2. For ONE-TIME schedules (specific date/time, relative like "tomorrow", "next Monday") → output: AT: <ISO 8601 datetime, e.g. 2026-04-02T12:00:00>

Rules:
- Use standard Linux 5-field cron format: minute hour day-of-month month day-of-week
- Day of week: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
- For AT responses: calculate the exact datetime based on the current time above. Use local time (no UTC offset needed).
- If description mentions execution counts like "3 times" or "重复3次", ignore the count.
- If you cannot parse the description, output exactly: ERROR

Examples:
- "every 15 minutes" → CRON: */15 * * * *
- "每15分钟" → CRON: */15 * * * *
- "every Monday at noon" → CRON: 0 12 * * 1
- "每周一 12:00" → CRON: 0 12 * * 1
- "every weekday at 8:30" → CRON: 30 8 * * 1-5
- "工作日 8:30" → CRON: 30 8 * * 1-5
- "tomorrow at noon" → AT: 2026-04-02T12:00:00
- "明天中午12:00" → AT: 2026-04-02T12:00:00
- "next Friday at 3pm" → AT: 2026-04-03T15:00:00
- "下周五下午3点" → AT: 2026-04-03T15:00:00
- "2026-05-01 09:00" → AT: 2026-05-01T09:00:00

Output ONLY one line starting with CRON:, AT:, or ERROR. Nothing else.`;

  try {
    const result = await apiService.chat(
      description,
      undefined,
      [{ role: 'system', content: systemPrompt }]
    );

    const raw = result.content.trim();

    if (!raw || raw === 'ERROR') {
      return { error: i18nService.t('scheduleParserConvertFailed') };
    }

    if (raw.startsWith('AT:')) {
      const isoStr = raw.slice(3).trim();
      const date = new Date(isoStr);
      if (!Number.isFinite(date.getTime())) {
        return { error: i18nService.t('scheduleParserInvalidCron') };
      }
      if (date.getTime() <= Date.now()) {
        return { error: i18nService.t('scheduleParserDatetimePast') };
      }
      return { kind: 'at', at: date.toISOString() };
    }

    if (raw.startsWith('CRON:')) {
      const expr = raw.slice(5).trim();
      const parts = expr.split(/\s+/);
      if (parts.length !== 5) {
        return { error: i18nService.t('scheduleParserInvalidCron') };
      }
      try {
        CronExpressionParser.parse(expr);
      } catch {
        return { error: i18nService.t('scheduleParserInvalidCron') };
      }
      return { kind: 'cron', cronExpr: expr };
    }

    return { error: i18nService.t('scheduleParserInvalidCron') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('API') || msg.includes('key') || msg.includes('configuration')) {
      return { error: i18nService.t('scheduleParserApiNotConfigured') };
    }
    return { error: i18nService.t('scheduleParserConvertFailed') };
  }
}

export function getNextRunDates(cronExpr: string, count: number = 5): Date[] {
  if (!cronExpr.trim()) return [];
  try {
    const interval = CronExpressionParser.parse(cronExpr);
    const results: Date[] = [];
    for (let i = 0; i < count; i++) {
      results.push(interval.next().toDate());
    }
    return results;
  } catch {
    return [];
  }
}

export function formatNextRunDate(date: Date): string {
  const lang = i18nService.getLanguage();
  if (lang === 'zh') {
    return date.toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
