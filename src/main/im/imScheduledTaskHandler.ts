import type { IMMediaAttachment, IMMessage } from './types';
import { IMChatHandler } from './imChatHandler';
import { buildOpenClawLocalTimeContextPrompt } from '../libs/openclawLocalTimeContextPrompt';
import {
  parseSimpleScheduledReminderText,
  parseLegacyScheduledReminderSystemMessage,
  parseScheduledReminderPrompt,
} from '../../scheduledTask/reminderText';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatUtcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absMinutes / 60);
  const minutes = absMinutes % 60;
  return `${sign}${pad(hours)}:${pad(minutes)}`;
}

function toLocalIsoWithOffset(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${formatUtcOffset(date)}`;
}

function formatLocalClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeReminderBody(value: string): string {
  return value
    .trim()
    .replace(/^[,，:：\s]+/u, '')
    .replace(/[。！？!?~～\s]+$/u, '')
    .replace(/^(?:一下|一声|一下子)\s*/u, '')
    .trim();
}

function normalizeReminderName(value: string): string {
  const normalized = value
    .replace(/[。！？!?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return '提醒';
  }
  const compact = normalized.length > 20 ? normalized.slice(0, 20).trim() : normalized;
  return compact.endsWith('提醒') ? compact : `${compact}提醒`;
}

function buildSystemEventText(body: string): string {
  if (!body) {
    return '⏰ 提醒';
  }
  if (body.startsWith('⏰')) {
    return body;
  }
  if (/^提醒[:：]?/u.test(body)) {
    return `⏰ ${body}`;
  }
  return `⏰ 提醒：${body}`;
}

function formatConfirmationText(delayLabel: string, runAt: Date, body: string): string {
  return `好的，已设置好提醒！${delayLabel}（${formatLocalClock(runAt)}）会提醒你${body}。`;
}

const SCHEDULED_TASK_CANDIDATE_RE =
  /(?:提醒|定时|闹钟|通知|叫我|叫醒|稍后|之后|到点|分钟后|小时后|秒后|天后|明天|后天|今晚|later|remind|reminder|alarm|timer|schedule|scheduled|tomorrow|tonight|in\s+\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?))/iu;

const ISO_WITH_TIMEZONE_RE = /(?:[zZ]|[+-]\d{2}:\d{2})$/u;

interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model?: string;
  provider?: string;
}

interface RawScheduledTaskDetection {
  shouldCreateTask?: boolean;
  scheduleAt?: string;
  reminderBody?: string;
  taskName?: string;
}

export interface ParsedIMScheduledTaskRequest {
  kind: 'create';
  sourceText: string;
  reminderBody: string;
  delayMs: number;
  delayLabel: string;
  runAt: Date;
  scheduleAt: string;
  taskName: string;
  payloadText: string;
  confirmationText: string;
}

export interface IMScheduledTaskCreationResult {
  id: string;
  name: string;
  agentId: string | null;
  sessionKey: string | null;
  payloadText: string;
  scheduleAt: string;
}

export interface IMScheduledTaskRequestDetector {
  (message: IMMessage): Promise<ParsedIMScheduledTaskRequest | null>;
}

function extractFirstJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fencedMatch?.[1]?.trim() || trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return candidate.slice(start, end + 1);
}

function parseDetectionPayload(raw: string): RawScheduledTaskDetection | null {
  const json = extractFirstJsonObject(raw);
  if (!json) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as RawScheduledTaskDetection;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function formatRelativeDelayLabel(now: Date, runAt: Date): string {
  const diffMs = Math.max(0, runAt.getTime() - now.getTime());
  const minuteMs = 60_000;
  const hourMs = 3_600_000;
  const dayMs = 86_400_000;

  if (diffMs < minuteMs) {
    const seconds = Math.max(1, Math.round(diffMs / 1000));
    return `${seconds}秒后`;
  }
  if (diffMs < hourMs) {
    const minutes = Math.max(1, Math.round(diffMs / minuteMs));
    return `${minutes}分钟后`;
  }
  if (diffMs < dayMs) {
    const hours = Math.max(1, Math.round(diffMs / hourMs));
    return `${hours}小时后`;
  }
  const days = Math.max(1, Math.round(diffMs / dayMs));
  return `${days}天后`;
}

export function looksLikeIMScheduledTaskCandidate(
  text: string,
  attachments?: IMMediaAttachment[],
): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return Array.isArray(attachments) && attachments.some((item) => item.type === 'audio' || item.type === 'voice');
  }
  return SCHEDULED_TASK_CANDIDATE_RE.test(normalized);
}

export function normalizeDetectedScheduledTaskRequest(
  payload: RawScheduledTaskDetection | null,
  sourceText: string,
  now = new Date(),
): ParsedIMScheduledTaskRequest | null {
  if (!payload?.shouldCreateTask) {
    return null;
  }

  const scheduleAt = typeof payload.scheduleAt === 'string' ? payload.scheduleAt.trim() : '';
  if (!scheduleAt || !ISO_WITH_TIMEZONE_RE.test(scheduleAt)) {
    return null;
  }

  const runAt = new Date(scheduleAt);
  if (!Number.isFinite(runAt.getTime()) || runAt.getTime() <= now.getTime()) {
    return null;
  }

  const reminderBody = normalizeReminderBody(
    typeof payload.reminderBody === 'string' ? payload.reminderBody : ''
  );
  if (!reminderBody) {
    return null;
  }

  const taskName = typeof payload.taskName === 'string' && payload.taskName.trim()
    ? normalizeReminderName(payload.taskName)
    : normalizeReminderName(reminderBody);
  const payloadText = buildSystemEventText(reminderBody);
  const delayLabel = formatRelativeDelayLabel(now, runAt);

  return {
    kind: 'create',
    sourceText,
    reminderBody,
    delayMs: Math.max(0, runAt.getTime() - now.getTime()),
    delayLabel,
    runAt,
    scheduleAt: toLocalIsoWithOffset(runAt),
    taskName,
    payloadText,
    confirmationText: formatConfirmationText(delayLabel, runAt, reminderBody),
  };
}

function buildScheduledTaskDetectionPrompt(now: Date): string {
  return [
    'You are a structured extractor for one-shot reminder requests in an IM conversation.',
    buildOpenClawLocalTimeContextPrompt(now),
    'Return JSON only. No markdown. No prose.',
    'Decide whether the user is explicitly asking to create a one-time scheduled reminder/task.',
    'If yes, return: {"shouldCreateTask":true,"scheduleAt":"ISO8601 with explicit timezone offset","reminderBody":"short reminder content","taskName":"short task name"}',
    'If no, return: {"shouldCreateTask":false}',
    'Rules:',
    '- Only return true when the user is explicitly asking to set a reminder or scheduled task.',
    '- `scheduleAt` must be a future absolute timestamp with timezone offset.',
    '- `reminderBody` should be the concise thing to remind, without filler.',
    '- If the time is ambiguous, missing, or not a one-shot reminder, return false.',
    `- If the message is just a voice-length placeholder like \`5''\` or otherwise lacks semantic reminder content, return false.`,
  ].join('\n\n');
}

export function createIMScheduledTaskRequestDetector(options: {
  getLLMConfig: () => Promise<LLMConfig | null>;
}): IMScheduledTaskRequestDetector {
  return async (message: IMMessage): Promise<ParsedIMScheduledTaskRequest | null> => {
    if (!looksLikeIMScheduledTaskCandidate(message.content, message.attachments)) {
      return null;
    }

    const llmConfig = await options.getLLMConfig();
    if (!llmConfig) {
      return null;
    }

    const now = new Date(message.timestamp || Date.now());
    const detector = new IMChatHandler({
      getLLMConfig: async () => llmConfig,
      imSettings: {
        skillsEnabled: false,
        systemPrompt: buildScheduledTaskDetectionPrompt(now),
      },
    });

    try {
      const raw = await detector.processMessage({
        ...message,
        attachments: undefined,
        mediaGroupId: undefined,
      });
      return normalizeDetectedScheduledTaskRequest(parseDetectionPayload(raw), message.content, now);
    } catch (error) {
      console.warn('[IMScheduledTask] Scheduled-task detection failed:', error);
      return null;
    }
  };
}

export function isReminderSystemTurn(messages: Array<{ type: string; content: string }>): boolean {
  return messages.some((message) => {
    const content = typeof message.content === 'string' ? message.content : '';
    // Only consider user and system messages — tool_use/tool_result/assistant
    // messages may contain reminder text from cron.add payloads which would
    // cause false positives on user-initiated task creation turns.
    if (message.type !== 'user' && message.type !== 'system') {
      return false;
    }
    if (message.type === 'system') {
      return parseSimpleScheduledReminderText(content) !== null
        || parseLegacyScheduledReminderSystemMessage(content) !== null;
    }
    return parseScheduledReminderPrompt(content) !== null
      || parseSimpleScheduledReminderText(content) !== null;
  });
}
