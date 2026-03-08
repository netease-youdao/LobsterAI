import React from 'react';

const AnthropicIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}>
    <title>Anthropic</title>
    <path d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L16.906 20.48h-3.674l-1.343-3.461H5.017l-1.344 3.46H0l6.569-16.96zm2.327 5.295L6.27 14.71h5.252l-2.626-5.894z" fill="#D97757" />
  </svg>
);

export default AnthropicIcon;
