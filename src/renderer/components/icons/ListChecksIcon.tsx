import React from 'react';

const ListChecksIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 6h10" />
      <path d="M11 12h10" />
      <path d="M11 18h10" />
      <path d="m3 6 2 2 4-4" />
      <path d="m3 12 2 2 4-4" />
      <path d="m3 18 2 2 4-4" />
    </svg>
  );
};

export default ListChecksIcon;
