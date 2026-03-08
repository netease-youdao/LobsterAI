import React from 'react';

const CustomProviderIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="currentColor" height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}>
    <title>Custom</title>
    <path d="M14.078 7.061l2.861 2.862-10.799 10.798-3.18.319a.534.534 0 01-.588-.588l.322-3.186L14.078 7.061zm7.028-1.51l-1.457 1.457-2.862-2.862 1.458-1.457a1.071 1.071 0 011.515 0l1.346 1.346a1.071 1.071 0 010 1.516z" />
  </svg>
);

export default CustomProviderIcon;
