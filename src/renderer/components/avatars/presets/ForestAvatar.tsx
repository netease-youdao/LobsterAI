import React from 'react';

/**
 * Forest Avatar - 森林
 * 绿色渐变 + 抽象叶子形状
 */
const ForestAvatar: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="forest-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="50%" stopColor="#22c55e" />
          <stop offset="100%" stopColor="#0d9488" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill="url(#forest-gradient)" />
      {/* 抽象叶子形状 */}
      <ellipse
        cx="35"
        cy="50"
        rx="12"
        ry="20"
        fill="rgba(255,255,255,0.25)"
        transform="rotate(-20 35 50)"
      />
      <ellipse
        cx="65"
        cy="50"
        rx="12"
        ry="20"
        fill="rgba(255,255,255,0.25)"
        transform="rotate(20 65 50)"
      />
      <ellipse
        cx="50"
        cy="45"
        rx="10"
        ry="18"
        fill="rgba(255,255,255,0.35)"
      />
      {/* 叶脉 */}
      <line
        x1="50"
        y1="30"
        x2="50"
        y2="60"
        stroke="rgba(255,255,255,0.2)"
        strokeWidth="1"
      />
    </svg>
  );
};

export default ForestAvatar;
