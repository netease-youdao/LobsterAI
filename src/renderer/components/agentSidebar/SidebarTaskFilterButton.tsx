import React from 'react';

import SidebarFilterIcon from '../icons/SidebarFilterIcon';

// Temporarily hidden until the task filter UX is polished. Flip to true to
// restore the entry in both the macOS sidebar header and the Windows title bar.
export const SIDEBAR_TASK_FILTER_ENABLED: boolean = false;

interface SidebarTaskFilterButtonProps {
  isActive: boolean;
  hasUnreadCompletedTasks: boolean;
  label: string;
  onClick: () => void;
  className?: string;
}

const SidebarTaskFilterButton: React.FC<SidebarTaskFilterButtonProps> = ({
  isActive,
  hasUnreadCompletedTasks,
  label,
  onClick,
  className = '',
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
        isActive
          ? 'bg-blue-500/10 text-blue-500'
          : 'text-secondary hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
      } ${className}`}
      aria-label={label}
      aria-pressed={isActive}
      title={label}
    >
      <SidebarFilterIcon className="h-4 w-4" />
      {hasUnreadCompletedTasks && (
        <span
          className="absolute right-1 top-1 h-[7px] w-[7px] rounded-full bg-blue-500"
          aria-hidden="true"
        />
      )}
    </button>
  );
};

export default SidebarTaskFilterButton;
