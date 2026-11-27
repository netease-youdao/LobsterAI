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
    <div className="flex min-h-7 py-1 w-full items-center gap-4 rounded-[9px] pl-[38px] pr-2.5 text-[length:var(--lobster-text-sidebarMeta)] font-normal">
      <button
        type="button"
        onClick={onClick}
        disabled={isLoading}
        className="min-w-0 text-left text-secondary transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isLoading ? i18nService.t('loading') : label}
      </button>
      {secondaryLabel && onSecondaryClick && (
        <button
          type="button"
          onClick={onSecondaryClick}
          className="min-w-0 text-left text-secondary transition-colors hover:text-foreground"
        >
          {secondaryLabel}
        </button>
      )}
    </div>
  );
};

export default ExpandAgentTasksRow;
