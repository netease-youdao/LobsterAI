import React from 'react';

const GoalIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg className={className} viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M24.5 9.5L18.5 15.5M24.5 9.5H19.5M24.5 9.5V14.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M27 17C27 22.5228 22.5228 27 17 27C11.4772 27 7 22.5228 7 17C7 11.4772 11.4772 7 17 7"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M21.5 17C21.5 19.4853 19.4853 21.5 17 21.5C14.5147 21.5 12.5 19.4853 12.5 17C12.5 14.5147 14.5147 12.5 17 12.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
};

export default GoalIcon;
