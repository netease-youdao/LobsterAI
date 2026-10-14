import React from 'react';

const MessageForkIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="1.5 1.5 21 21"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M4.94116 11.2943H12.3361L18.7059 4.58838"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14.1177 4.23535H19.0589V9.17653"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <path
      d="M13.4117 14.1177L19.0588 19.7647"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <path
      d="M19.0589 14.8235V19.7647H14.1177"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

export default MessageForkIcon;
