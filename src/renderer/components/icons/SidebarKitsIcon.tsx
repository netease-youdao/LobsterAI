import React from 'react';

const SidebarKitsIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg className={className} viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="9.904"
        y="3.698"
        width="8.777"
        height="8.777"
        rx="1.241"
        transform="rotate(45 9.904 3.698)"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <rect
        x="4.939"
        y="19.834"
        width="9.93"
        height="9.93"
        rx="2.483"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <rect
        x="19.834"
        y="4.939"
        width="9.93"
        height="9.93"
        rx="4.965"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <rect
        x="19.834"
        y="19.834"
        width="9.93"
        height="9.93"
        rx="4.965"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default SidebarKitsIcon;
