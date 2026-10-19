import React from 'react';

/** A simple person and a small spark, readable at sidebar icon sizes. */
const ExpertIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="9" cy="8" r="3.25" />
    <path d="M2.75 20v-1.5a6.25 5 0 0 1 12.5 0V20" />
    <path d="m18.5 3 .9 2.6L22 6.5l-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9Z" />
  </svg>
);

export default ExpertIcon;
