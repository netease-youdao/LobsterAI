import React from 'react';

const ActiveSkillIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2h4v2a1 1 0 0 0 2 0V2h2v4h-2a1 1 0 0 0 0 2h2v4h-2V10a1 1 0 0 0-2 0v2H6v-2a1 1 0 0 0-2 0v2H2V8h2a1 1 0 0 0 0-2H2V2h2v2a1 1 0 0 0 2 0V2z" />
    </svg>
  );
};

export default ActiveSkillIcon;
