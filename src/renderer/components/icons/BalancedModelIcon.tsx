import React from 'react';

const BalancedModelIcon: React.FC<{ className?: string }> = ({ className = '' }) => (
  <svg
    viewBox="0 0 24 24"
    className={`text-gray-700 dark:text-foreground ${className}`}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14 2 4 14h7l-1 8 10-12h-7l1-8Z" />
  </svg>
);

export default BalancedModelIcon;
