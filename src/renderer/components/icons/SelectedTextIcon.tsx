import React from 'react';

const SelectedTextIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 34 34"
    fill="none"
    aria-hidden="true"
  >
    <path
      opacity="0.4"
      d="M6 9C6 6.79086 7.79086 5 10 5H24C26.2091 5 28 6.79086 28 9V20C28 24.9706 23.9706 29 19 29H10C7.79086 29 6 27.2091 6 25V9Z"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    />
    <path
      opacity="0.4"
      d="M12.4974 13.9988H21.9974"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      opacity="0.4"
      d="M12.4974 19.4988H17.9974"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default SelectedTextIcon;
