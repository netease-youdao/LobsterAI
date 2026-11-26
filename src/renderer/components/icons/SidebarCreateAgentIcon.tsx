import React from 'react';

const SidebarCreateAgentIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.5 18H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.9a1.5 1.5 0 0 1 1.06.44l1.3 1.3a1.5 1.5 0 0 0 1.06.44H18.5a2 2 0 0 1 2 2V12" />
      <path d="M15.5 18h6" />
      <path d="M18.5 15v6" />
    </svg>
  );
};

export default SidebarCreateAgentIcon;
