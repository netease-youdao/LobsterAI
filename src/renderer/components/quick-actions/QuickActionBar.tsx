import React from 'react';

import type { LocalizedQuickAction } from '../../types/quickAction';
import AcademicCapIcon from '../icons/AcademicCapIcon';
import ChartBarIcon from '../icons/ChartBarIcon';
import DevicePhoneMobileIcon from '../icons/DevicePhoneMobileIcon';
import DocumentTextIcon from '../icons/DocumentTextIcon';
import GlobeAltIcon from '../icons/GlobeAltIcon';
import PresentationChartBarIcon from '../icons/PresentationChartBarIcon';

interface QuickActionBarProps {
  actions: LocalizedQuickAction[];
  selectedActionId?: string | null;
  onActionSelect: (actionId: string) => void;
}

// 图标映射
const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  PresentationChartBarIcon,
  GlobeAltIcon,
  DevicePhoneMobileIcon,
  DocumentTextIcon,
  ChartBarIcon,
  AcademicCapIcon,
};

const QuickActionBar: React.FC<QuickActionBarProps> = ({ actions, selectedActionId, onActionSelect }) => {
  if (actions.length === 0) {
    return null;
  }

  return (
    <div data-skin-quick-actions="true" className="flex flex-wrap items-center justify-center gap-2">
      {actions.map((action) => {
        const IconComponent = iconMap[action.icon];
        const isSelected = action.id === selectedActionId;

        return (
          <button
            key={action.id}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onActionSelect(action.id)}
            className={`group flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[length:var(--lobster-text-sidebarCompact)] font-normal leading-5 transition-all duration-200 ease-out active:translate-y-0 active:scale-[0.97] ${
              isSelected
                ? 'border-[color-mix(in_srgb,var(--lobster-primary)_50%,transparent)] bg-primary-muted text-primary'
                : 'border-border-subtle bg-surface text-secondary hover:-translate-y-px hover:border-primary/30 hover:bg-surface-raised hover:text-foreground hover:shadow-subtle'
            }`}
          >
            {IconComponent && (
              <IconComponent
                className={`h-3.5 w-3.5 transition-colors duration-200 ${
                  isSelected ? 'text-primary' : 'text-secondary group-hover:text-primary'
                }`}
              />
            )}
            <span>{action.label}</span>
          </button>
        );
      })}
    </div>
  );
};

export default QuickActionBar;
