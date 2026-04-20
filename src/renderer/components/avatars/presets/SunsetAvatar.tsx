import React from 'react';

/**
 * Sunset Avatar - 日落
 * 暖色渐变 + 太阳和光线
 */
const SunsetAvatar: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="sunset-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#fb7185" />
          <stop offset="50%" stopColor="#fb923c" />
          <stop offset="100%" stopColor="#fcd34d" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill="url(#sunset-gradient)" />
      {/* 太阳 */}
      <circle cx="50" cy="55" r="18" fill="rgba(255,255,255,0.3)" />
      <circle cx="50" cy="55" r="12" fill="rgba(255,255,255,0.5)" />
      {/* 光线 */}
      <line
        x1="50"
        y1="20"
        x2="50"
        y2="10"
        stroke="rgba(255,255,255,0.3)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="25"
        y1="30"
        x2="18"
        y2="22"
        stroke="rgba(255,255,255,0.3)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="75"
        y1="30"
        x2="82"
        y2="22"
        stroke="rgba(255,255,255,0.3)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
};

export default SunsetAvatar;
