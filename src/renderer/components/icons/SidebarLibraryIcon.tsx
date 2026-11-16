import React from 'react';

const SidebarLibraryIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 34 34"
    fill="none"
    className={className}
    aria-hidden="true"
  >
    <rect
      x="4.946"
      y="4.264"
      width="11.774"
      height="25.51"
      rx="1.962"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <rect
      x="17.21"
      y="5.314"
      width="5.887"
      height="25.51"
      rx="1.962"
      transform="rotate(-15 17.21 5.314)"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M10.833 4.395V29.283"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default SidebarLibraryIcon;
