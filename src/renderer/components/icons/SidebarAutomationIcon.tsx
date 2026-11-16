import React from 'react';

const SidebarAutomationIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg className={className} viewBox="0 0 34 34" fill="none" aria-hidden="true">
      <path
        d="M17 29.774C24.055 29.774 29.774 24.055 29.774 17C29.774 9.945 24.055 4.226 17 4.226C9.945 4.226 4.226 9.945 4.226 17C4.226 24.055 9.945 29.774 17 29.774Z"
        stroke="currentColor"
        strokeWidth="2.4"
      />
      <path
        d="M17 10.613V17L21.258 19.661"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default SidebarAutomationIcon;
