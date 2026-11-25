import React from 'react';

interface PushPinIconProps extends React.SVGProps<SVGSVGElement> {
  filled?: boolean;
  slashed?: boolean;
}

const PushPinIcon: React.FC<PushPinIconProps> = ({
  filled = false,
  slashed = false,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.65}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    <path
      d="M14 3.5L20.5 10L19.5 11L18.6 10.1L15 12.8Q15.4 15.2 13.6 17L7 10.4Q8.8 8.6 11.2 9L13.9 5.4L13 4.5Z"
      fill={filled ? 'currentColor' : 'none'}
    />
    <path d="M10.3 13.7L4 20" />
    {slashed && (
      <path d="M4.5 4.5L19.5 19.5" strokeWidth={1.8} />
    )}
  </svg>
);

export default PushPinIcon;
