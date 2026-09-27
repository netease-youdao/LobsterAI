import React from 'react';

import SidebarSearchIcon from '../icons/SidebarSearchIcon';

interface SidebarTaskSearchButtonProps {
  label: string;
  onClick: () => void;
  className?: string;
}

const SidebarTaskSearchButton: React.FC<SidebarTaskSearchButtonProps> = ({
  label,
  onClick,
  className = '',
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-foreground/80 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04] ${className}`}
      aria-label={label}
      title={label}
    >
      <SidebarSearchIcon className="h-[18px] w-[18px]" />
    </button>
  );
};

export default SidebarTaskSearchButton;
