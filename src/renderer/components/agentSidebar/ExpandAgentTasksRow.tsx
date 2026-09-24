import React from 'react';

import { i18nService } from '../../services/i18n';

interface ExpandAgentTasksRowProps {
  isLoading: boolean;
  label: string;
  onClick: () => void;
  secondaryLabel?: string;
  onSecondaryClick?: () => void;
}

const ExpandAgentTasksRow: React.FC<ExpandAgentTasksRowProps> = ({
  isLoading,
  label,
  onClick,
  secondaryLabel,
  onSecondaryClick,
}) => {
  return (
    <div className="-ml-[6px] flex h-8 w-[calc(100%+12px)] items-center gap-5 rounded-full pl-9 pr-2.5 text-xs font-normal">
      <button
        type="button"
        onClick={onClick}
        disabled={isLoading}
        className="min-w-0 text-left text-secondary/80 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isLoading ? i18nService.t('loading') : label}
      </button>
      {secondaryLabel && onSecondaryClick && (
        <button
          type="button"
          onClick={onSecondaryClick}
          className="min-w-0 text-left text-secondary/80 transition-colors hover:text-foreground"
        >
          {secondaryLabel}
        </button>
      )}
    </div>
  );
};

export default ExpandAgentTasksRow;
