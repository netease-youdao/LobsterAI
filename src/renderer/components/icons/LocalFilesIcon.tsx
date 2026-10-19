import React from 'react';

const LocalFilesIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 34 34" fill="none" className={className} aria-hidden="true">
    <path
      d="M4.25067 9.66845C4.25067 7.45931 6.04153 5.66846 8.25067 5.66846H12.6465C13.6262 5.66846 14.5718 6.02797 15.304 6.67882L16.2182 7.49143C16.9504 8.14228 17.896 8.50179 18.8756 8.50179H25.7507C27.9598 8.50179 29.7507 10.2927 29.7507 12.5018V24.3351C29.7507 26.5443 27.9598 28.3351 25.7507 28.3351H8.25067C6.04153 28.3351 4.25067 26.5443 4.25067 24.3351V9.66845Z"
      stroke="currentColor"
      strokeWidth="2.4"
    />
    <path
      d="M8 14.25C8 13.5596 8.55964 13 9.25 13H24.75C25.4404 13 26 13.5596 26 14.25C26 14.9404 25.4404 15.5 24.75 15.5H9.25C8.55964 15.5 8 14.9404 8 14.25Z"
      fill="currentColor"
    />
  </svg>
);

export default LocalFilesIcon;
