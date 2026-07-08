import React from 'react';

const PlanModeIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg className={className} viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 10.7143L8.54545 13L13 9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 12H29" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M16 22H29" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="8.5" cy="22.5" r="2.5" stroke="currentColor" strokeWidth="2.4" />
    </svg>
  );
};

export default PlanModeIcon;
