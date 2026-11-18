import React from 'react';

// Line folder on the same 34px grid and 2.4 stroke as the agent avatar icons it sits next to.
const WorkingDirectoryIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 34 34"
    fill="none"
    className={className}
    aria-hidden="true"
  >
    <path
      d="M4.25067 8.50179C4.25067 6.93698 5.5192 5.66846 7.084 5.66846H13.0901C13.784 5.66846 14.4538 5.92311 14.9725 6.38413L16.5497 7.78612C17.0683 8.24713 17.7381 8.50179 18.4321 8.50179H26.9173C28.4821 8.50179 29.7507 9.77032 29.7507 11.3351V25.5018C29.7507 27.0666 28.4821 28.3351 26.9173 28.3351H7.08401C5.5192 28.3351 4.25067 27.0666 4.25067 25.5018V8.50179Z"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinejoin="round"
    />
  </svg>
);

export default WorkingDirectoryIcon;
