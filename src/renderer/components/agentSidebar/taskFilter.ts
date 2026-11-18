import type { CoworkSessionFilterQuery } from '../../../shared/cowork/sessionFilter';
import { CoworkSessionStatusValue, type CoworkSessionSummary } from '../../types/cowork';
import type { AgentSidebarAgentNode, AgentSidebarTaskNode } from './types';

export const SidebarTaskStatusFilter = {
  All: 'all',
  Running: 'running',
  PendingPermission: 'pendingPermission',
  CompletedUnread: 'completedUnread',
  Error: 'error',
} as const;
export type SidebarTaskStatusFilter = typeof SidebarTaskStatusFilter[keyof typeof SidebarTaskStatusFilter];

export const SidebarTaskTimeFilter = {
  All: 'all',
  Today: 'today',
  Last7Days: 'last7Days',
  Last30Days: 'last30Days',
} as const;
export type SidebarTaskTimeFilter = typeof SidebarTaskTimeFilter[keyof typeof SidebarTaskTimeFilter];

export interface SidebarTaskFilter {
  status: SidebarTaskStatusFilter;
  time: SidebarTaskTimeFilter;
}

export const DEFAULT_SIDEBAR_TASK_FILTER: SidebarTaskFilter = {
  status: SidebarTaskStatusFilter.All,
  time: SidebarTaskTimeFilter.All,
};

export const SIDEBAR_TASK_STATUS_FILTER_OPTIONS: readonly SidebarTaskStatusFilter[] = [
  SidebarTaskStatusFilter.All,
  SidebarTaskStatusFilter.Running,
  SidebarTaskStatusFilter.PendingPermission,
  SidebarTaskStatusFilter.CompletedUnread,
  SidebarTaskStatusFilter.Error,
];

export const SIDEBAR_TASK_TIME_FILTER_OPTIONS: readonly SidebarTaskTimeFilter[] = [
  SidebarTaskTimeFilter.All,
  SidebarTaskTimeFilter.Today,
  SidebarTaskTimeFilter.Last7Days,
  SidebarTaskTimeFilter.Last30Days,
];

/** Days covered by each time range, counting today as the first day. */
const DAYS_BY_TIME_FILTER: Record<Exclude<SidebarTaskTimeFilter, 'all'>, number> = {
  [SidebarTaskTimeFilter.Today]: 1,
  [SidebarTaskTimeFilter.Last7Days]: 7,
  [SidebarTaskTimeFilter.Last30Days]: 30,
};

export interface SidebarTaskRuntimeState {
  completedUnreadSessionIds: ReadonlySet<string>;
  pendingPermissionSessionIds: ReadonlySet<string>;
}

export interface AgentSidebarActivityItem {
  agent: AgentSidebarAgentNode;
  task: AgentSidebarTaskNode;
}

export const isSidebarTaskFilterActive = (filter: SidebarTaskFilter): boolean => (
  filter.status !== SidebarTaskStatusFilter.All || filter.time !== SidebarTaskTimeFilter.All
);

/** Start of the time range in local time, or undefined for "all time". */
export const getSidebarTaskFilterUpdatedSince = (
  time: SidebarTaskTimeFilter,
  now: number = Date.now(),
): number | undefined => {
  if (time === SidebarTaskTimeFilter.All) return undefined;
  const date = new Date(now);
  // setDate keeps local midnight correct across daylight-saving changes.
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - (DAYS_BY_TIME_FILTER[time] - 1),
  ).getTime();
};

/**
 * Database query for the filter, or null when the result is known to be empty
 * (for example "awaiting permission" while nothing awaits permission).
 */
export const buildSidebarTaskFilterQuery = (
  filter: SidebarTaskFilter,
  runtime: SidebarTaskRuntimeState,
  now: number = Date.now(),
): CoworkSessionFilterQuery | null => {
  const query: CoworkSessionFilterQuery = {};
  const updatedSince = getSidebarTaskFilterUpdatedSince(filter.time, now);
  if (updatedSince !== undefined) query.updatedSince = updatedSince;

  switch (filter.status) {
    case SidebarTaskStatusFilter.Running:
      query.statuses = [CoworkSessionStatusValue.Running];
      break;
    case SidebarTaskStatusFilter.Error:
      query.statuses = [CoworkSessionStatusValue.Error];
      break;
    case SidebarTaskStatusFilter.PendingPermission:
      if (runtime.pendingPermissionSessionIds.size === 0) return null;
      query.sessionIds = Array.from(runtime.pendingPermissionSessionIds);
      break;
    case SidebarTaskStatusFilter.CompletedUnread:
      if (runtime.completedUnreadSessionIds.size === 0) return null;
      query.sessionIds = Array.from(runtime.completedUnreadSessionIds);
      break;
    default:
      break;
  }
  return query;
};

/** Same rule as the database query, applied to fresher in-memory session state. */
export const matchesSidebarTaskFilter = (
  session: Pick<CoworkSessionSummary, 'id' | 'status' | 'updatedAt' | 'createdAt'>,
  filter: SidebarTaskFilter,
  runtime: SidebarTaskRuntimeState,
  now: number = Date.now(),
): boolean => {
  const updatedSince = getSidebarTaskFilterUpdatedSince(filter.time, now);
  if (updatedSince !== undefined && (session.updatedAt || session.createdAt) < updatedSince) {
    return false;
  }
  switch (filter.status) {
    case SidebarTaskStatusFilter.Running:
      return session.status === CoworkSessionStatusValue.Running;
    case SidebarTaskStatusFilter.Error:
      return session.status === CoworkSessionStatusValue.Error;
    case SidebarTaskStatusFilter.PendingPermission:
      return runtime.pendingPermissionSessionIds.has(session.id);
    case SidebarTaskStatusFilter.CompletedUnread:
      return runtime.completedUnreadSessionIds.has(session.id);
    default:
      return true;
  }
};

/**
 * Prefer the live in-memory copy of each queried session, drop ones that no
 * longer match, and keep newest first.
 */
export const reconcileSidebarTaskFilterResults = (
  queried: CoworkSessionSummary[],
  live: CoworkSessionSummary[],
  filter: SidebarTaskFilter,
  runtime: SidebarTaskRuntimeState,
  now: number = Date.now(),
): CoworkSessionSummary[] => {
  const liveById = new Map(live.map(session => [session.id, session]));
  return queried
    .map(session => liveById.get(session.id) ?? session)
    .filter(session => matchesSidebarTaskFilter(session, filter, runtime, now))
    .sort((left, right) => (
      (right.updatedAt || right.createdAt) - (left.updatedAt || left.createdAt)
    ));
};
