import { PlusIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '../../services/i18n';
import Tooltip, { TooltipAlign, TooltipPosition } from '../ui/Tooltip';

interface MyAgentSidebarHeaderProps {
  onCreateAgent: () => void;
}

const MyAgentSidebarHeader: React.FC<MyAgentSidebarHeaderProps> = ({
  onCreateAgent,
}) => {
  return (
    <div className="group sticky top-0 z-30 -mx-2.5 flex h-9 items-center justify-between bg-[var(--lobster-sidebar-bg)] px-2.5">
      <h2 className="min-w-0 truncate pl-2.5 text-[length:var(--lobster-text-sidebarMeta)] font-medium tracking-[0.01em] text-secondary">
        {i18nService.t('myAgents')}
      </h2>
      <Tooltip
        content={i18nService.t('createNewAgent')}
        position={TooltipPosition.Bottom}
        align={TooltipAlign.End}
        delay={300}
        className="mr-0.5 opacity-75 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:opacity-100"
      >
        <button
          type="button"
          onClick={onCreateAgent}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-secondary transition-colors hover:bg-[var(--lobster-sidebar-item-hover)] hover:text-foreground"
          aria-label={i18nService.t('createNewAgent')}
        >
          <PlusIcon className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </Tooltip>
    </div>
  );
};

export default MyAgentSidebarHeader;
