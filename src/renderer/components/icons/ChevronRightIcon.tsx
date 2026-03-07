import React from 'react';

const ChevronRightIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m8.25 4.5 7.5 7.5-7.5 7.5" />
    </svg>
  );
};

export default ChevronRightIcon;
