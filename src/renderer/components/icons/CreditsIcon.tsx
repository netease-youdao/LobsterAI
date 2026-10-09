import React from 'react';

/** A coin stack with a spent coin in front: credits consumed by a turn. */
const CreditsIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => {
  return (
    <svg
      viewBox="-0.5 -0.5 26 26"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <ellipse cx="9" cy="6.5" rx="6" ry="2.5" />
      <path d="M3 6.5v9c0 1.38 2.69 2.5 6 2.5" />
      <path d="M3 11c0 1.38 2.69 2.5 6 2.5" />
      <path d="M15 6.5v3" />
      <circle cx="16.5" cy="15.5" r="5.5" />
      <path d="M17.4 12.4 15 15.9h3l-2.4 3.5" />
    </svg>
  );
};

export default CreditsIcon;
