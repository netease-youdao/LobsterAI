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

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  PresentationChartBarIcon,
  GlobeAltIcon,
  DevicePhoneMobileIcon,
  DocumentTextIcon,
  ChartBarIcon,
  AcademicCapIcon,
};

const iconAccentMap: Record<string, string> = {
  PresentationChartBarIcon: 'text-rose-500 dark:text-rose-400',
  ChartBarIcon: 'text-emerald-600 dark:text-emerald-400',
  DocumentTextIcon: 'text-violet-500 dark:text-violet-400',
  GlobeAltIcon: 'text-blue-500 dark:text-blue-400',
  DevicePhoneMobileIcon: 'text-cyan-600 dark:text-cyan-400',
  AcademicCapIcon: 'text-indigo-500 dark:text-indigo-400',
};

export interface QuickActionChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  selected?: boolean;
  icon?: React.ReactNode;
  iconAccentClassName?: string;
  label: React.ReactNode;
  badge?: React.ReactNode;
}

export const QuickActionChip: React.FC<QuickActionChipProps> = ({
  selected = false,
  icon,
  iconAccentClassName = 'text-secondary',
  label,
  badge,
  className = '',
  ...buttonProps
}) => (
  <button
    type="button"
    aria-pressed={selected}
    {...buttonProps}
    className={`group relative flex min-h-[112px] w-full flex-col items-start justify-between rounded-2xl border px-3.5 py-4 text-left transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 active:translate-y-0 active:scale-[0.98] ${
      selected
        ? 'border-primary/45 bg-primary-muted/60 shadow-subtle ring-1 ring-primary/15'
        : 'border-border-input bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.03)] hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-[0_6px_18px_rgba(0,0,0,0.06)] dark:hover:border-foreground/20 dark:hover:bg-surface-raised/60'
    }${className ? ` ${className}` : ''}`}
  >
    <div className="flex w-full items-start justify-between gap-2">
      {icon && (
        <span
          aria-hidden="true"
          className={`inline-flex shrink-0 transition-transform duration-200 group-hover:scale-105 ${iconAccentClassName}`}
        >
          {icon}
        </span>
      )}
      {badge && <span className="shrink-0">{badge}</span>}
    </div>
    <span className="mt-4 line-clamp-2 w-full text-sm font-medium leading-snug text-foreground">
      {label}
    </span>
  </button>
);

const QuickActionBar: React.FC<QuickActionBarProps> = ({ actions, selectedActionId, onActionSelect, children }) => {
  if (actions.length === 0 && !children) {
    return null;
  }

  return (
    <div
      data-skin-quick-actions="true"
      className="grid w-full grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5"
    >
      {actions.map((action) => {
        const IconComponent = iconMap[action.icon];
        const isSelected = action.id === selectedActionId;

        return (
          <QuickActionChip
            key={action.id}
            selected={isSelected}
            onClick={() => onActionSelect(action.id)}
            icon={IconComponent && <IconComponent className="h-6 w-6" />}
            iconAccentClassName={iconAccentMap[action.icon] ?? 'text-secondary'}
            label={action.label}
          />
        );
      })}
      {children}
    </div>
  );
};

export default QuickActionBar;
