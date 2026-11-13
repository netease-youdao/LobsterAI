import React from 'react';

const OpenAppIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 34 34"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14.735 5.518H11.28C8.81 5.518 7.575 5.518 6.631 5.999C5.801 6.422 5.127 7.096 4.704 7.926C4.223 8.87 4.223 10.105 4.223 12.575V22.72C4.223 25.19 4.223 26.425 4.704 27.369C5.127 28.199 5.801 28.874 6.631 29.297C7.575 29.777 8.81 29.777 11.28 29.777H21.425C23.895 29.777 25.13 29.777 26.074 29.297C26.904 28.874 27.579 28.199 28.002 27.369C28.482 26.425 28.482 25.19 28.482 22.72V19.265" />
    <path d="M16.35 17.65 28.5 5.5M18.6 5.5h9.9v9.9" />
  </svg>
);

export default OpenAppIcon;
