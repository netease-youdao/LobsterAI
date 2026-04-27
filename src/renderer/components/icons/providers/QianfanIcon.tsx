import React from 'react';

const QianfanIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}>
    <title>Qianfan</title>
    <defs>
      <linearGradient id="qianfan-grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#1A73E8" />
        <stop offset="100%" stopColor="#4FC3F7" />
      </linearGradient>
    </defs>
    <rect width="20" height="20" x="2" y="2" rx="4" fill="url(#qianfan-grad)" />
    <text x="12" y="16.5" textAnchor="middle" fill="#fff" fontSize="11" fontWeight="bold" fontFamily="-apple-system, sans-serif">千</text>
  </svg>
);

export default QianfanIcon;
