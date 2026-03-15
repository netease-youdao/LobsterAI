import React from 'react';

const LMStudioIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="currentColor" height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}>
    <title>LM Studio</title>
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1.5 14.5H8V7.5h2.5v9zm5 0H13V7.5h2.5v9z" />
  </svg>
);

export default LMStudioIcon;
