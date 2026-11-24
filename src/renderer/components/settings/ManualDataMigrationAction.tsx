import React from 'react';

import { i18nService } from '../../services/i18n';
import Tooltip, { TooltipAlign, TooltipPosition } from '../ui/Tooltip';

interface ManualDataMigrationActionProps {
  children: React.ReactNode;
  onClick: () => void;
}

export default function ManualDataMigrationAction({ children, onClick }: ManualDataMigrationActionProps) {
  return (
    <Tooltip
      content={i18nService.t('openClawDataMigrationUnderDevelopment')}
      position={TooltipPosition.Top}
      align={TooltipAlign.End}
      className="shrink-0 self-start sm:self-auto"
    >
      <span tabIndex={0} className="inline-flex cursor-not-allowed rounded-lg">
        <button
          type="button"
          disabled
          onClick={onClick}
          className="pointer-events-none inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground opacity-60"
        >
          {children}
        </button>
      </span>
    </Tooltip>
  );
}
