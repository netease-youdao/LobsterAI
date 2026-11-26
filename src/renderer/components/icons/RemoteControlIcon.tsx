import React from 'react';

const RemoteControlIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M12 16H4.5a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2V7" />
    <path d="M8.5 16v4m-3 0h6" />
    <rect x="15" y="10" width="6.5" height="10.5" rx="1.5" />
    <path d="M17.75 18h1" />
  </svg>
);

export default RemoteControlIcon;
