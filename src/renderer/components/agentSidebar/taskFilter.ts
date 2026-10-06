import { AgentSidebarIndicator } from './constants';
import type { AgentSidebarAgentNode, AgentSidebarTaskNode } from './types';

export const AgentSidebarActivityRecentLimit = 5;

export interface AgentSidebarActivityItem {
  agent: AgentSidebarAgentNode;
  task: AgentSidebarTaskNode;
}

export interface AgentSidebarActivityView {
  priority: AgentSidebarActivityItem[];
  recent: AgentSidebarActivityItem[];
}

interface IndexedActivityItem extends AgentSidebarActivityItem {
  agentIndex: number;
  taskIndex: number;
}

const priorityRankByIndicator: Partial<Record<AgentSidebarTaskNode['indicator'], number>> = {
  [AgentSidebarIndicator.PendingPermission]: 0,
  [AgentSidebarIndicator.CompletedUnread]: 1,
  [AgentSidebarIndicator.Running]: 2,
};

const getTaskTimestamp = (task: AgentSidebarTaskNode): number => (
  task.updatedAt || task.createdAt
);

const compareRecency = (left: IndexedActivityItem, right: IndexedActivityItem): number => {
  const timestampDifference = getTaskTimestamp(right.task) - getTaskTimestamp(left.task);
  if (timestampDifference !== 0) return timestampDifference;
  if (left.agentIndex !== right.agentIndex) return left.agentIndex - right.agentIndex;
  return left.taskIndex - right.taskIndex;
};

const isPriorityTask = (task: AgentSidebarTaskNode): boolean => (
  priorityRankByIndicator[task.indicator] !== undefined
);

const selectRecentWithAgentCoverage = (
  candidates: IndexedActivityItem[],
  limit: number,
): IndexedActivityItem[] => {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : candidates.length;
  if (normalizedLimit === 0) return [];

  const selected: IndexedActivityItem[] = [];
  const selectedItems = new Set<IndexedActivityItem>();
  const coveredAgentIds = new Set<string>();

  for (const candidate of candidates) {
    if (selected.length >= normalizedLimit) break;
    if (coveredAgentIds.has(candidate.agent.id)) continue;
    coveredAgentIds.add(candidate.agent.id);
    selected.push(candidate);
    selectedItems.add(candidate);
  }

  for (const candidate of candidates) {
    if (selected.length >= normalizedLimit) break;
    if (selectedItems.has(candidate)) continue;
    selected.push(candidate);
  }

  return selected.sort(compareRecency);
};

export const hasUnreadCompletedAgentTasks = (
  agentNodes: AgentSidebarAgentNode[],
): boolean => agentNodes.some((agent) => agent.tasks.some(
  (task) => task.indicator === AgentSidebarIndicator.CompletedUnread,
));

export const buildAgentSidebarActivityView = (
  agentNodes: AgentSidebarAgentNode[],
  recentLimit = AgentSidebarActivityRecentLimit,
): AgentSidebarActivityView => {
  const activityItems = agentNodes.flatMap((agent, agentIndex) => (
    agent.tasks.map((task, taskIndex): IndexedActivityItem => ({
      agent,
      task,
      agentIndex,
      taskIndex,
    }))
  ));

  const priority = activityItems
    .filter((item) => isPriorityTask(item.task))
    .sort((left, right) => {
      const rankDifference = (
        priorityRankByIndicator[left.task.indicator] ?? Number.MAX_SAFE_INTEGER
      ) - (
        priorityRankByIndicator[right.task.indicator] ?? Number.MAX_SAFE_INTEGER
      );
      return rankDifference || compareRecency(left, right);
    });

  const recentCandidates = activityItems
    .filter((item) => !isPriorityTask(item.task))
    .sort(compareRecency);
  const recent = selectRecentWithAgentCoverage(recentCandidates, recentLimit);

  return { priority, recent };
};
