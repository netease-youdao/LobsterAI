import React from 'react';

const AtlasCloudIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="currentColor" fillRule="evenodd" height="24" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg" style={{flex: '0 0 auto', lineHeight: 1}}>
    <title>Atlas Cloud</title>
    <path d="M20.2,18.01L12,0.47,3.8,18.01l-2.58,5.52c1.62,-1.05,3.39,-1.86,5.26,-2.41,1.76,-0.51,3.61,-0.79,5.52,-0.79,0.98,0,1.95,0.08,2.9,0.22l-1.86,-4.3c-0.53,-0.1,-2.87,-0.1,-4.59,0.3l3.56,-8.28,5.52,12.85c0.01,0,0.02,0.01,0.03,0.01,1.86,0.55,3.62,1.36,5.23,2.4l-2.58,-5.52Z" />
  </svg>
);

export default AtlasCloudIcon;
