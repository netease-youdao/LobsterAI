import React from 'react';

const RequestyIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}>
    <title>Requesty</title>
    <g transform="rotate(-5 12 12)">
      <path d="M4.5 3h15A2.5 2.5 0 0122 5.5v10a2.5 2.5 0 01-2.5 2.5h-8.25L7.5 22v-4h-3A2.5 2.5 0 012 15.5v-10A2.5 2.5 0 014.5 3z" fill="#1A73F5" />
      <path d="M6.5 7.5l4 2.75-4 2.75" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M12.5 14.5h4.5" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.8" />
    </g>
  </svg>
);

export default RequestyIcon;
