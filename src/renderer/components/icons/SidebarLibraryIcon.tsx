import React from 'react';

const SidebarLibraryIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 34 34"
    fill="none"
    className={className}
    aria-hidden="true"
  >
    <rect
      x="5.29999"
      y="4"
      width="12"
      height="26"
      rx="2"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <rect
      x="17.8"
      y="5.07056"
      width="6"
      height="26"
      rx="2"
      transform="rotate(-15 17.8 5.07056)"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M11.3 4.13391V29.5"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default SidebarLibraryIcon;
