import { getCoworkRailPreview } from '../cowork/rail';

export const CompanionResultMessageType = {
  User: 'user', Assistant: 'assistant', ToolUse: 'tool_use', ToolResult: 'tool_result', System: 'system',
} as const;

export const CompanionResultIpc = {
  Open: 'desktop-companion:result-open',
  Hide: 'desktop-companion:result-hide',
  Dismiss: 'desktop-companion:result-dismiss',
  Pin: 'desktop-companion:result-pin',
  Recent: 'desktop-companion:result-recent',
  PassThrough: 'desktop-companion:result-pass-through',
} as const;

export const COMPANION_RECENT_TASKS_KEY = 'desktop-companion.recent-tasks.v1';
export const COMPANION_RECENT_TASK_LIMIT = 10;

export interface CompanionTaskRecord {
  sessionId: string;
  viewedAt: number;
}

export interface CompanionTaskInfo {
  id: string;
  title: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  updatedAt: number;
  preview?: string;
}

/** A bounded plain-text excerpt, never a tool result, thinking or intermediate update. */
export function getCompanionTaskPreview(message?: {
  type: string;
  content: string;
  metadata?: { isThinking?: boolean; isError?: boolean; isFinal?: boolean };
}): string {
  if (message?.type !== CompanionResultMessageType.Assistant || message.metadata?.isThinking
    || message.metadata?.isError || message.metadata?.isFinal === false) return '';
  return getCoworkRailPreview(message.content, '', 180);
}

export interface CompanionRecentTask extends CompanionTaskInfo {
  viewedAt: number;
}

export interface CompanionResultState {
  visible: boolean;
  pinned: boolean;
  cardMaxHeight: number;
  recentTasks: CompanionTaskRecord[];
}

export interface CompanionResultsBridge {
  /** Opens the task in the main window, or shows recent activity when no session ID is supplied. */
  openResult(sessionId?: string): Promise<void>;
  hideResult(): Promise<void>;
  /** Removes only this task's floating record; the Cowork session keeps its history and execution state. */
  dismissResult(sessionId: string): Promise<void>;
  pinResult(pinned: boolean): Promise<void>;
  getRecentTasks(): Promise<CompanionRecentTask[]>;
  setResultPassThrough(passThrough: boolean): Promise<void>;
}

/** Stored IDs survive restarts; answers and titles remain owned by Cowork. */
export function normalizeCompanionTaskRecords(value: unknown): CompanionTaskRecord[] {
  if (!Array.isArray(value)) return [];
  const records = new Map<string, CompanionTaskRecord>();
  for (const item of value) {
    if (!item || typeof item.sessionId !== 'string' || !item.sessionId.trim() || item.sessionId.length > 200) continue;
    if (records.has(item.sessionId)) continue;
    records.set(item.sessionId, {
      sessionId: item.sessionId,
      viewedAt: typeof item.viewedAt === 'number' && Number.isFinite(item.viewedAt) && item.viewedAt > 0 ? item.viewedAt : 0,
    });
    if (records.size === COMPANION_RECENT_TASK_LIMIT) break;
  }
  return [...records.values()];
}
