import React from 'react';

const SidebarFilterIcon: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2c1.84 0 3.64.16 5.39.45.35.06.61.37.61.73v.7c0 .4-.16.78-.44 1.06L9.94 8.56c-.28.28-.44.66-.44 1.06v1.95c0 .56-.31 1.07-.83 1.34L6.5 14V9.62c0-.4-.16-.78-.44-1.06L2.44 4.94A1.5 1.5 0 0 1 2 3.88v-.7c0-.36.26-.67.61-.73A32.2 32.2 0 0 1 8 2Z" />
    </svg>
  );
};

export default SidebarFilterIcon;
