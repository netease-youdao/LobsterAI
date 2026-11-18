import React from 'react';

const SidebarToggleIcon: React.FC<{ className?: string; isCollapsed: boolean }> = ({ className, isCollapsed }) => {
  const dividerX = isCollapsed ? 4 : 6;
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.13" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <line x1={dividerX} y1="2" x2={dividerX} y2="14" />
    </svg>
  );
};

export default SidebarToggleIcon;
