import React from 'react';

/**
 * Ocean Avatar - 深海
 * 深蓝渐变 + 同心圆波纹
 */
const OceanAvatar: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="ocean-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#0891b2" />
          <stop offset="50%" stopColor="#2563eb" />
          <stop offset="100%" stopColor="#4338ca" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill="url(#ocean-gradient)" />
      {/* 同心圆波纹 */}
      <circle
        cx="50"
        cy="50"
        r="15"
        fill="none"
        stroke="rgba(255,255,255,0.3)"
        strokeWidth="1.5"
      />
      <circle
        cx="50"
        cy="50"
        r="25"
        fill="none"
        stroke="rgba(255,255,255,0.2)"
        strokeWidth="1.5"
      />
      <circle
        cx="50"
        cy="50"
        r="35"
        fill="none"
        stroke="rgba(255,255,255,0.1)"
        strokeWidth="1.5"
      />
      <circle
        cx="50"
        cy="50"
        r="45"
        fill="none"
        stroke="rgba(255,255,255,0.05)"
        strokeWidth="1.5"
      />
    </svg>
  );
};

export default OceanAvatar;
