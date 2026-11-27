import React from 'react';

import { i18nService } from '../../services/i18n';
import SidebarCreateAgentIcon from '../icons/SidebarCreateAgentIcon';
import Tooltip, { TooltipAlign, TooltipPosition } from '../ui/Tooltip';
import {
  SIDEBAR_HEADER_BUTTON_FOCUS_CLASS_NAME,
  SIDEBAR_HEADER_TOOLTIP_BUBBLE_CLASS_NAME,
} from './sidebarHeaderTooltip';
import SidebarTaskFilterButton, { SIDEBAR_TASK_FILTER_ENABLED } from './SidebarTaskFilterButton';
import {
  EMPTY_SIDEBAR_TASK_STATUS_COUNTS,
  type SidebarTaskFilter,
  type SidebarTaskStatusCounts,
} from './taskFilter';

interface MyAgentSidebarHeaderProps {
  taskFilter: SidebarTaskFilter;
  taskStatusCounts?: SidebarTaskStatusCounts;
  onTaskFilterChange: (filter: SidebarTaskFilter) => void;
  onCreateAgent: () => void;
}

const MyAgentSidebarHeader: React.FC<MyAgentSidebarHeaderProps> = ({
  taskFilter,
  taskStatusCounts = EMPTY_SIDEBAR_TASK_STATUS_COUNTS,
  onTaskFilterChange,
  onCreateAgent,
}) => {
  return (
    <div className="group sticky top-0 z-30 -mx-2.5 flex h-9 items-center justify-between bg-[var(--lobster-sidebar-bg)] px-2.5">
      <h2 className="min-w-0 truncate pl-2.5 text-[length:var(--lobster-text-sidebarMeta)] font-medium tracking-[0.01em] text-secondary">
        {i18nService.t('myAgents')}
      </h2>
      <div className="mr-0.5 flex shrink-0 items-center gap-0.5">
        {SIDEBAR_TASK_FILTER_ENABLED && (
          <SidebarTaskFilterButton
            filter={taskFilter}
            onChange={onTaskFilterChange}
            statusCounts={taskStatusCounts}
            label={i18nService.t('sidebarFilter')}
            tooltipAlign={TooltipAlign.End}
          />
        )}
        <Tooltip
          content={i18nService.t('createNewAgent')}
          position={TooltipPosition.Bottom}
          align={TooltipAlign.End}
          delay={300}
          bubbleClassName={SIDEBAR_HEADER_TOOLTIP_BUBBLE_CLASS_NAME}
          className="shrink-0"
        >
          <button
            type="button"
            onClick={onCreateAgent}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground ${SIDEBAR_HEADER_BUTTON_FOCUS_CLASS_NAME}`}
            aria-label={i18nService.t('createNewAgent')}
          >
            <SidebarCreateAgentIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
};

export default MyAgentSidebarHeader;
