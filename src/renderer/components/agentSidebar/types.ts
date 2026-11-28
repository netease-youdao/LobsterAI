import type { AgentSource } from '@shared/agent/constants';

import type { Platform } from '../../../shared/platform';
import type { CoworkSessionStatus } from '../../types/cowork';
import type { AgentSidebarIndicator, PinnedTaskSortMode } from './constants';

export interface AgentSidebarAgentSummary {
  id: string;
  name: string;
  icon: string;
  iconCustomized?: boolean;
  workingDirectory?: string;
  source?: AgentSource;
  presetId?: string;
  updateRevision?: number;
  enabled: boolean;
  pinned: boolean;
  pinOrder?: number | null;
  sortOrder?: number | null;
}

export interface AgentSidebarTaskNode {
  id: string;
  agentId: string;
  title: string;
  isScheduledTask: boolean;
  status: CoworkSessionStatus;
  pinned: boolean;
  pinOrder?: number | null;
  cwd?: string;
  forkGitBranch?: string | null;
  imPlatform?: Platform | null;
  isExternalDshSession?: boolean;
  updatedAt: number;
  createdAt: number;
  indicator: AgentSidebarIndicator;
  isSelected: boolean;
}

export interface AgentSidebarAgentNode extends AgentSidebarAgentSummary {
  isExpanded: boolean;
  isTaskListExpanded: boolean;
  canExpandTasks: boolean;
  canCollapseTasks: boolean;
  isLoadingTasks: boolean;
  hasLoadError: boolean;
  tasks: AgentSidebarTaskNode[];
}

export interface AgentSidebarPreferenceState {
  expandedAgentIds: string[];
  expandedTaskListAgentIds: string[];
  isPinnedSectionCollapsed?: boolean;
  pinnedTaskSortMode?: PinnedTaskSortMode;
  selectedAgentId?: string;
  selectedTaskId?: string;
}
