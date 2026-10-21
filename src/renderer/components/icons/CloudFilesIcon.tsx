import React from 'react';

const CloudFilesIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 34 34" fill="none" className={className} aria-hidden="true">
    <path
      d="M9 14.1447C9 15.8296 9.52253 17.473 10.4956 18.8485"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    />
    <path
      d="M24.0498 25.9937H9.63579C6.1334 26.146 3.16458 23.5384 3.00669 20.1669C2.84724 16.7963 5.55784 13.9395 9.06022 13.7864C9.05089 9.69038 12.3479 6.2905 16.5947 6.01743C20.8414 5.74514 24.5787 8.69272 25.1348 12.7541C28.7142 13.2849 31.263 16.3832 30.9783 19.8577C30.6936 23.333 27.6727 26.009 24.0505 25.9937H24.0498Z"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    />
  </svg>
);

export default CloudFilesIcon;
