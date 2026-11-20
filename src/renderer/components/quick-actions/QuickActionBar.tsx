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
  children?: React.ReactNode;
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

export interface QuickActionChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  selected?: boolean;
  icon?: React.ReactNode;
  label: React.ReactNode;
  badge?: React.ReactNode;
}

export const QuickActionChip: React.FC<QuickActionChipProps> = ({
  selected = false,
  icon,
  label,
  badge,
  className = '',
  ...buttonProps
}) => (
  <button
    type="button"
    aria-pressed={selected}
    {...buttonProps}
    className={`group flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[length:var(--lobster-text-sidebarCompact)] font-normal leading-5 transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 active:translate-y-0 active:scale-[0.97] ${
      selected
        ? 'border-primary/45 bg-primary-muted text-primary-hover hover:border-primary/60 hover:bg-primary/15'
        : 'border-border-subtle bg-surface text-secondary hover:-translate-y-px hover:border-primary/30 hover:bg-surface-raised hover:text-foreground hover:shadow-subtle'
    }${className ? ` ${className}` : ''}`}
  >
    {icon && (
      <span
        aria-hidden="true"
        className={`inline-flex shrink-0 transition-colors duration-200 ${
          selected ? 'text-primary-hover' : 'text-secondary group-hover:text-primary'
        }`}
      >
        {icon}
      </span>
    )}
    <span>{label}</span>
    {badge}
  </button>
);

const QuickActionBar: React.FC<QuickActionBarProps> = ({ actions, selectedActionId, onActionSelect, children }) => {
  if (actions.length === 0 && !children) {
    return null;
  }

  return (
    <div data-skin-quick-actions="true" className="flex flex-wrap items-center justify-center gap-2">
      {actions.map((action) => {
        const IconComponent = iconMap[action.icon];
        const isSelected = action.id === selectedActionId;

        return (
          <QuickActionChip
            key={action.id}
            selected={isSelected}
            onClick={() => onActionSelect(action.id)}
            icon={IconComponent && <IconComponent className="h-3.5 w-3.5" />}
            label={action.label}
          />
        );
      })}
      {children}
    </div>
  );
};

export default QuickActionBar;
