import React from 'react';

interface ShareUploadIconProps {
  className?: string;
}

const ShareUploadIcon: React.FC<ShareUploadIconProps> = ({ className }) => (
  <svg
    className={className}
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2 11v1.5A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V11" />
    <path d="M5 5l3-3 3 3" />
    <path d="M8 2v9" />
  </svg>
);

export default ShareUploadIcon;
