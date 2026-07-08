import React from 'react';

import type { LocalizedQuickAction } from '../../types/quickAction';
import AcademicCapIcon from '../icons/AcademicCapIcon';
import ChartBarIcon from '../icons/ChartBarIcon';
import DevicePhoneMobileIcon from '../icons/DevicePhoneMobileIcon';
import GlobeAltIcon from '../icons/GlobeAltIcon';
import PresentationChartBarIcon from '../icons/PresentationChartBarIcon';

interface QuickActionBarProps {
  actions: LocalizedQuickAction[];
  onActionSelect: (actionId: string) => void;
}

// 图标映射
const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  PresentationChartBarIcon,
  GlobeAltIcon,
  DevicePhoneMobileIcon,
  ChartBarIcon,
  AcademicCapIcon,
};

const QuickActionBar: React.FC<QuickActionBarProps> = ({ actions, onActionSelect }) => {
  if (actions.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {actions.map((action) => {
        const IconComponent = iconMap[action.icon];

        return (
          <button
            key={action.id}
            type="button"
            onClick={() => onActionSelect(action.id)}
            className="group flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface px-3.5 py-1.5 text-[length:var(--lobster-text-sidebarCompact)] font-normal leading-5 text-secondary transition-all duration-200 ease-out hover:-translate-y-px hover:border-primary/30 hover:bg-surface-raised hover:text-foreground hover:shadow-subtle active:translate-y-0 active:scale-[0.97]"
          >
            {IconComponent && (
              <IconComponent className="h-3.5 w-3.5 text-secondary transition-colors duration-200 group-hover:text-primary" />
            )}
            <span>{action.label}</span>
          </button>
        );
      })}
    </div>
  );
};

export default QuickActionBar;
