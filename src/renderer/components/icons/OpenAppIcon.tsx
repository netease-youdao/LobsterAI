import React from 'react';

const OpenAppIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 34 34"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.40429"
    strokeLinecap="round"
  >
    <path d="M19.6801 5H28C28.5523 5 29 5.44772 29 6V14.3199M28.2831 5.71691L14 20" />
    <path d="M11.5385 5H7.42857C6.08731 5 5 6.08731 5 7.42857V26.5714C5 27.9127 6.08731 29 7.42857 29H26.5714C27.9127 29 29 27.9127 29 26.5714V22.4615" />
  </svg>
);

export default OpenAppIcon;
