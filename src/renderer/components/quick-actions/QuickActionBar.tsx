import React from 'react';
import type { LocalizedQuickAction } from '../../types/quickAction';
import PresentationChartBarIcon from '../icons/PresentationChartBarIcon';
import GlobeAltIcon from '../icons/GlobeAltIcon';
import DevicePhoneMobileIcon from '../icons/DevicePhoneMobileIcon';
import ChartBarIcon from '../icons/ChartBarIcon';
import AcademicCapIcon from '../icons/AcademicCapIcon';

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
    <div className="flex flex-wrap items-center justify-center gap-2.5">
      {actions.map((action) => {
        const IconComponent = iconMap[action.icon];

        return (
          <button
            key={action.id}
            type="button"
            onClick={() => onActionSelect(action.id)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all duration-200 ease-out dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover hover:border-claude-accent/40"
          >
            {IconComponent && (
              <IconComponent className="w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            )}
            <span>{action.label}</span>
          </button>
        );
      })}
    </div>
  );
};

export default QuickActionBar;
