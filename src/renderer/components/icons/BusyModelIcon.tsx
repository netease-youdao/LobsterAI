import React from 'react';

const BusyModelIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="7" cy="5" r="2.5" />
    <path d="M3 17v-4a3 3 0 0 1 5.5-1.7L11 15h3M3 21v-4h5v4" />
    <path d="m14 10-1.5 7H21M11 17h11M19 17v4" />
    <path d="M14 3v2M18 4l-1 2M21 7l-2 1" />
  </svg>
);

export default BusyModelIcon;
