import React from 'react';

const SubagentIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M12 5.75V3.75"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
    <circle cx="12" cy="3.25" r="1" fill="currentColor" />
    <rect
      x="4.5"
      y="6.5"
      width="15"
      height="12.25"
      rx="3.5"
      stroke="currentColor"
      strokeWidth="1.7"
    />
    <path
      d="M8.5 11.75H8.51M15.49 11.75H15.5"
      stroke="currentColor"
      strokeWidth="2.15"
      strokeLinecap="round"
    />
    <path
      d="M9 15.25H15"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
    <path
      d="M3 12.5H4.5M19.5 12.5H21"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  </svg>
);

export default SubagentIcon;
