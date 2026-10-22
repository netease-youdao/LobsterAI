import { MediaDeliveryStatus, MediaProtocol, TERMINAL_MEDIA_TASK_STATUSES } from '../../../shared/media/constants';
import type { ConversationTurn, ToolGroupItem } from './messageDisplayUtils';

type MediaDetails = Record<string, unknown>;

export type MediaTaskPresentation = {
  details: MediaDetails;
  startedAt?: number;
  showCard: boolean;
};

export type MediaTaskPresentations = ReadonlyMap<string, MediaTaskPresentation>;

const MEDIA_TOOL_NAMES = new Set(['lobsteraiimagegenerate', 'lobsteraivideogenerate']);
export const isMediaGenerationToolName = (name: string): boolean =>
  MEDIA_TOOL_NAMES.has(name.replace(/[^a-z0-9]/gi, '').toLowerCase());

const taskIdOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return String(value).trim() || undefined;
};

const taskCreatedAt = (details: MediaDetails): number | undefined => {
  if (typeof details.createdAt !== 'string') return undefined;
  const createdAt = details.createdAt.trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(createdAt)) return undefined;
  const offsetPattern = /(?:Z|[+-]\d{2}:\d{2})$/i;
  // Unzoned task dates use the deadline's offset, never the desktop's timezone.
  const offset = typeof details.deadlineAt === 'string' ? details.deadlineAt.match(offsetPattern)?.[0] : undefined;
  if (!offsetPattern.test(createdAt) && !offset) return undefined;
  const timestamp = Date.parse(offsetPattern.test(createdAt) ? createdAt : `${createdAt}${offset}`);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
};

const resultReceivedAt = (group: ToolGroupItem): number | undefined => {
  const timestamp = group.toolResult?.timestamp;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
};

const clientStartedAt = (details: MediaDetails): number | undefined => {
  const timestamp = details.clientStartedAt;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
};

// A late query response must not turn a finished task back into a running one,
// or turn an already saved file back into a pending download.
const mergeDetails = (previous: MediaDetails, next: MediaDetails): MediaDetails => {
  if ((TERMINAL_MEDIA_TASK_STATUSES.has(String(previous.status))
      && !TERMINAL_MEDIA_TASK_STATUSES.has(String(next.status)))
    || (previous.deliveryStatus === MediaDeliveryStatus.Saved
      && next.deliveryStatus !== MediaDeliveryStatus.Saved)) {
    return { ...next, ...previous };
  }
  return { ...previous, ...next };
};

const detailsOf = (group: ToolGroupItem): MediaDetails => mergeDetails(
  group.toolResult?.metadata?.toolResultDetails as MediaDetails ?? {},
  group.toolUse.metadata?.mediaStatusDetails as MediaDetails ?? {},
);

/** One card per task in the loaded conversation; calls remain individually inspectable. */
export const buildMediaTaskPresentations = (turns: readonly ConversationTurn[]): MediaTaskPresentations => {
  const tasks = new Map<string, { ownerId: string; startedAt?: number; details: MediaDetails }>();
  const groups: ToolGroupItem[] = [];
  for (const turn of turns) {
    for (const item of turn.assistantItems) {
      if (item.type !== 'tool_group') continue;
      groups.push(item.group);
      const details = detailsOf(item.group);
      const taskId = taskIdOf(details.taskId);
      if (details.protocolVersion !== MediaProtocol.Durable || !taskId) continue;
      const createdAt = taskCreatedAt(details);
      const task = tasks.get(taskId);
      if (task) {
        task.details = mergeDetails(task.details, details);
        task.startedAt = clientStartedAt(task.details) ?? createdAt ?? task.startedAt ?? resultReceivedAt(item.group);
      } else {
        tasks.set(taskId, {
          ownerId: item.group.toolUse.id,
          startedAt: clientStartedAt(details) ?? createdAt ?? resultReceivedAt(item.group),
          details,
        });
      }
    }
  }
  const presentations = new Map<string, MediaTaskPresentation>();
  for (const group of groups) {
    const details = detailsOf(group);
    const input = group.toolUse.metadata?.toolInput as MediaDetails | undefined;
    const toolName = group.toolUse.metadata?.toolName?.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const taskId = details.protocolVersion === MediaProtocol.Durable
      ? taskIdOf(details.taskId)
      : MEDIA_TOOL_NAMES.has(toolName ?? '') ? taskIdOf(input?.taskId) : undefined;
    const task = taskId ? tasks.get(taskId) : undefined;
    if (!task) continue;
    presentations.set(group.toolUse.id, {
      details: task.details,
      startedAt: task.startedAt,
      showCard: group.toolUse.id === task.ownerId,
    });
  }
  return presentations;
};
