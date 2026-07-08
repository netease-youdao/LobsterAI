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
    <div className="group sticky top-0 z-30 -ml-[6px] flex h-10 w-[calc(100%+12px)] items-center justify-between bg-surface-raised pl-3 pr-1">
      <h2 className="min-w-0 truncate text-sm font-normal text-secondary">
        {i18nService.t('myAgents')}
      </h2>
      <Tooltip
        content={i18nService.t('createNewAgent')}
        position={TooltipPosition.Bottom}
        align={TooltipAlign.End}
        delay={300}
        className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <button
          type="button"
          onClick={onCreateAgent}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-foreground/60 transition-colors hover:text-foreground"
          aria-label={i18nService.t('createNewAgent')}
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      </Tooltip>
    </div>
  );
};

export default MyAgentSidebarHeader;
