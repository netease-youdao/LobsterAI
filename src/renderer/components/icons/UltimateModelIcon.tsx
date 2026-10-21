import React from 'react';

const UltimateModelIcon: React.FC<{ className?: string }> = ({ className = '' }) => (
  <svg
    viewBox="0 0 34 34"
    className={`text-gray-700 dark:text-foreground ${className}`}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M31.208 10.6938L29.3643 27.7905C29.2819 28.5521 28.6391 29.1294 27.873 29.1294H6.28906C5.52826 29.1294 4.8875 28.5598 4.79883 27.8042L2.81348 10.8706L16.1924 17.5845C16.7665 17.8725 17.444 17.8677 18.0137 17.5708L31.208 10.6938Z" />
    <path d="M28.327 28.0357L18.3643 6.2303C17.8303 5.06144 16.1697 5.06144 15.6357 6.2303L5.673 28.0357" />
    <circle cx="17" cy="23.7651" r="2.55176" fill="currentColor" stroke="none" />
  </svg>
);

export default UltimateModelIcon;
