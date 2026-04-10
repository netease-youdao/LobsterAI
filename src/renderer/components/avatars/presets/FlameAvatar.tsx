import React from 'react';

/**
 * Flame Avatar - 火焰
 * 橙红渐变 + 火焰形状
 */
const FlameAvatar: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="flame-gradient" x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#dc2626" />
          <stop offset="50%" stopColor="#f97316" />
          <stop offset="100%" stopColor="#fbbf24" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill="url(#flame-gradient)" />
      {/* 火焰形状 */}
      <path
        d="M50,15 Q65,40 60,55 Q70,50 65,65 Q75,60 70,75 Q65,90 50,90 Q35,90 30,75 Q25,60 35,65 Q30,50 40,55 Q35,40 50,15"
        fill="rgba(255,255,255,0.25)"
      />
      <path
        d="M50,35 Q58,50 55,60 Q60,58 57,68 Q62,65 58,75 Q55,85 50,85 Q45,85 42,75 Q38,65 43,68 Q40,58 45,60 Q42,50 50,35"
        fill="rgba(255,255,255,0.4)"
      />
    </svg>
  );
};

export default FlameAvatar;
