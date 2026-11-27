import React from 'react';

const DefaultAgentIcon: React.FC<{ className?: string }> = ({ className }) => {
  const gradientId = `default-agent-fill-${React.useId().replace(/:/g, '')}`;
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="20" height="20" rx="6" fill={`url(#${gradientId})`} />
      <path
        d="M8.45 8.15C7.2 7.8 5.9 8.75 5.62 10.48c-.25 1.58.52 2.82 1.62 2.82.7 0 1.25-.36 1.68-.96"
        fill="white"
        fillOpacity="0.96"
      />
      <path
        d="M15.55 8.15c1.25-.35 2.55.6 2.83 2.33.25 1.58-.52 2.82-1.62 2.82-.7 0-1.25-.36-1.68-.96"
        fill="white"
        fillOpacity="0.96"
      />
      <path
        d="M12 8.85c1.58 0 2.82 2.05 2.82 4.75v1.6c0 .44-.36.8-.8.8H9.98a.8.8 0 0 1-.8-.8v-1.6c0-2.7 1.24-4.75 2.82-4.75Z"
        fill="white"
        fillOpacity="0.96"
      />
      <path
        d="M9.35 17.55h5.3"
        stroke="white"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M10.9 8.9c-.14-1.05-.62-1.92-1.5-2.55M13.1 8.9c.14-1.05.62-1.92 1.5-2.55"
        stroke="white"
        strokeWidth="1.05"
        strokeLinecap="round"
      />
      <defs>
        <linearGradient id={gradientId} x1="4.2" y1="3.2" x2="20.2" y2="21.2" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ff7b58" />
          <stop offset="0.46" stopColor="#ff3d24" />
          <stop offset="1" stopColor="#d92216" />
        </linearGradient>
      </defs>
    </svg>
  );
};

export default DefaultAgentIcon;
