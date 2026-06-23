import React from 'react';

const LiteLLMIcon: React.FC<{ className?: string }> = ({ className }) => (
  <span
    className={className}
    role="img"
    aria-label="LiteLLM"
    style={{ fontSize: '1.2em', lineHeight: 1 }}
  >
    🚅
  </span>
);

export default LiteLLMIcon;
