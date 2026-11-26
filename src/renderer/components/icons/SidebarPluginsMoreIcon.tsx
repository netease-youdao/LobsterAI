import React from 'react';

const SidebarPluginsMoreIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg className={className} viewBox="0 0 34 34" fill="none" aria-hidden="true">
      <rect
        x="4.7"
        y="4.7"
        width="9.8"
        height="9.8"
        rx="2.6"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <rect
        x="4.7"
        y="19.5"
        width="9.8"
        height="9.8"
        rx="2.6"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <rect
        x="19.5"
        y="19.5"
        width="9.8"
        height="9.8"
        rx="2.6"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path
        d="M24.4 4.7V14.5M19.5 9.6H29.3"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default SidebarPluginsMoreIcon;
