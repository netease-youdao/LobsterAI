import React from 'react';

import { i18nService } from '../../services/i18n';

interface ExpandAgentTasksRowProps {
  isLoading: boolean;
  label: string;
  onClick: () => void;
}

const ExpandAgentTasksRow: React.FC<ExpandAgentTasksRowProps> = ({
  isLoading,
  label,
  onClick,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLoading}
      className="-ml-[6px] flex h-7 w-[calc(100%+12px)] items-center rounded-md pl-[38px] pr-2.5 text-left text-[length:var(--lobster-text-sidebarCompact)] font-normal transition-colors hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-white/[0.04]"
    >
      <span className="text-secondary">
        {isLoading ? i18nService.t('loading') : label}
      </span>
    </button>
  );
};

export default ExpandAgentTasksRow;
