import React from 'react';

/**
 * Nebula Avatar - 星云
 * 紫黑径向渐变 + 星点和连线
 */
const NebulaAvatar: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient id="nebula-gradient" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#c026d3" />
          <stop offset="50%" stopColor="#7c3aed" />
          <stop offset="100%" stopColor="#312e81" />
        </radialGradient>
      </defs>
      <rect width="100" height="100" fill="url(#nebula-gradient)" />
      {/* 星星 */}
      <circle cx="25" cy="30" r="2" fill="rgba(255,255,255,0.8)" />
      <circle cx="75" cy="25" r="1.5" fill="rgba(255,255,255,0.6)" />
      <circle cx="80" cy="60" r="2" fill="rgba(255,255,255,0.7)" />
      <circle cx="30" cy="70" r="1.5" fill="rgba(255,255,255,0.5)" />
      <circle cx="55" cy="40" r="1" fill="rgba(255,255,255,0.4)" />
      <circle cx="20" cy="55" r="1" fill="rgba(255,255,255,0.5)" />
      <circle cx="70" cy="75" r="1.5" fill="rgba(255,255,255,0.6)" />
      {/* 星座连线 */}
      <line
        x1="25"
        y1="30"
        x2="55"
        y2="40"
        stroke="rgba(255,255,255,0.2)"
        strokeWidth="0.5"
      />
      <line
        x1="55"
        y1="40"
        x2="80"
        y2="60"
        stroke="rgba(255,255,255,0.2)"
        strokeWidth="0.5"
      />
      <line
        x1="30"
        y1="70"
        x2="55"
        y2="40"
        stroke="rgba(255,255,255,0.15)"
        strokeWidth="0.5"
      />
    </svg>
  );
};

export default NebulaAvatar;
