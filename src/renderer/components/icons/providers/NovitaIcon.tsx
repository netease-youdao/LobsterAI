import React from 'react';

const NovitaIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}>
    <title>Novita AI</title>
    <path d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.18l7.5 3.75v6.14L12 17.82l-7.5-3.75V7.93L12 4.18z" fill="currentColor" />
    <path d="M12 7.5L7 10v4l5 2.5 5-2.5v-4l-5-2.5zm0 1.68l2.5 1.25v2.14L12 13.82l-2.5-1.25v-2.14L12 9.18z" fill="currentColor" />
  </svg>
);

export default NovitaIcon;