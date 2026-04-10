import React from 'react';

const DefaultProviderIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.5" height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}>
    <title>Provider</title>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 16.05V7.95a1.5 1.5 0 00-.75-1.3l-7.5-4.33a1.5 1.5 0 00-1.5 0l-7.5 4.33A1.5 1.5 0 003 7.95v8.1a1.5 1.5 0 00.75 1.3l7.5 4.33a1.5 1.5 0 001.5 0l7.5-4.33a1.5 1.5 0 00.75-1.3z" />
    <circle cx="12" cy="12" r="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default DefaultProviderIcon;
