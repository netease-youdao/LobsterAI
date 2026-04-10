import React from 'react';

/**
 * Aurora Avatar - 极光
 * 紫蓝粉渐变 + 流动波浪线
 */
const AuroraAvatar: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="aurora-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="50%" stopColor="#a855f7" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill="url(#aurora-gradient)" />
      {/* 三条波浪线 */}
      <path
        d="M0,55 Q20,45 40,55 T80,55 T100,55"
        fill="none"
        stroke="rgba(255,255,255,0.4)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M0,65 Q25,50 50,65 T100,65"
        fill="none"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M0,75 Q30,60 60,75 T100,75"
        fill="none"
        stroke="rgba(255,255,255,0.15)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
};

export default AuroraAvatar;
