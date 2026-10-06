import React from 'react';

interface SiteDefaultIconProps {
  className?: string;
}

const SiteDefaultIcon: React.FC<SiteDefaultIconProps> = ({ className = '' }) => (
  <div
    className={`relative h-[50px] w-20 shrink-0 overflow-hidden rounded-lg border border-border bg-surface text-[#2E9EFF] shadow-sm ${className}`}
    aria-hidden="true"
  >
    <svg
      viewBox="0 0 80 50"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-full w-full"
    >
      <rect opacity="0.7" x="5" y="5" width="4" height="4" rx="2" fill="#FF5F57" />
      <rect opacity="0.7" x="11" y="5" width="4" height="4" rx="2" fill="#FEBC2E" />
      <rect opacity="0.7" x="17" y="5" width="4" height="4" rx="2" fill="#28C840" />
      <path
        d="M46.6667 30.8485C46.6667 31.8526 45.8526 32.6667 44.8485 32.6667H41.8182C40.814 32.6667 40 31.8526 40 30.8485V26H44.8485C45.8526 26 46.6667 26.814 46.6667 27.8182V30.8485Z"
        fill="currentColor"
      />
      <path
        d="M45.3333 19.3359C46.0697 19.3359 46.6667 19.9329 46.6667 20.6693V22.6693C46.6667 23.4057 46.0697 24.0026 45.3333 24.0026H43.3333C42.597 24.0026 42 23.4057 42 22.6693V20.6693C42 19.9329 42.597 19.3359 43.3333 19.3359H45.3333Z"
        fill="currentColor"
        fillOpacity="0.78"
      />
      <path
        d="M36.6667 28C37.4031 28 38 28.597 38 29.3333V31.3333C38 32.0697 37.4031 32.6667 36.6667 32.6667H34.6667C33.9303 32.6667 33.3334 32.0697 33.3334 31.3333V29.3333C33.3334 28.597 33.9303 28 34.6667 28H36.6667Z"
        fill="currentColor"
        fillOpacity="0.78"
      />
      <path
        d="M40 26.0026H35.1516C34.1474 26.0026 33.3334 25.1886 33.3334 24.1844V21.1541C33.3334 20.15 34.1474 19.3359 35.1516 19.3359H38.1819C39.186 19.3359 40 20.15 40 21.1541V26.0026Z"
        fill="currentColor"
      />
    </svg>
  </div>
);

export default SiteDefaultIcon;
