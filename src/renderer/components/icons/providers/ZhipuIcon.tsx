import React from 'react';

const ZhipuIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    height="24"
    viewBox="0 0 1000 1000"
    width="24"
    xmlns="http://www.w3.org/2000/svg"
    style={{ flex: '0 0 auto', lineHeight: 1 }}
  >
    <title>Zhipu</title>
    <defs>
      <linearGradient
        id="zhipu-icon-light-background"
        gradientUnits="userSpaceOnUse"
        x1="500"
        x2="500"
        y1="865"
        y2="135"
      >
        <stop offset="0" stopColor="#000000" />
        <stop offset="1" stopColor="#151718" />
      </linearGradient>
      <linearGradient
        id="zhipu-icon-dark-background"
        gradientUnits="userSpaceOnUse"
        x1="500"
        x2="500"
        y1="873"
        y2="127"
      >
        <stop offset="0" stopColor="#000000" />
        <stop offset="1" stopColor="#151718" />
      </linearGradient>
    </defs>

    <g className="dark:hidden">
      <path
        fill="url(#zhipu-icon-light-background)"
        d="M754.06,865H245.94C184.67,865,135,815.33,135,754.06V245.94C135,184.67,184.67,135,245.94,135h508.12C815.33,135,865,184.67,865,245.94v508.12C865,815.33,815.33,865,754.06,865z"
      />
    </g>

    <g className="hidden dark:block">
      <path
        fill="url(#zhipu-icon-dark-background)"
        d="M245.94,873C180.36,873,127,819.64,127,754.06V245.94C127,180.36,180.36,127,245.94,127h508.12C819.64,127,873,180.36,873,245.94v508.12C873,819.64,819.64,873,754.06,873H245.94z"
      />
      <path
        fill="#B7BCBF"
        d="M754.06,135C815.33,135,865,184.67,865,245.94v508.12C865,815.33,815.33,865,754.06,865H245.94C184.67,865,135,815.33,135,754.06V245.94C135,184.67,184.67,135,245.94,135H754.06 M754.06,119H245.94c-33.91,0-65.78,13.2-89.76,37.18S119,212.03,119,245.94v508.12c0,33.91,13.2,65.78,37.18,89.76C180.16,867.8,212.03,881,245.94,881h508.12c33.91,0,65.78-13.2,89.76-37.18C867.8,819.84,881,787.97,881,754.06V245.94c0-33.91-13.2-65.78-37.18-89.76C819.84,132.2,787.97,119,754.06,119L754.06,119z"
      />
    </g>

    <g fill="#FFFFFF">
      <path d="M512.56,286.53l-35.18,50.01c-5.53,7.79-14.57,12.56-24.37,12.56H261.28v-62.82C261.28,286.53,512.56,286.53,512.56,286.53z" />
      <polygon points="751.28,286.53 449.74,713.72 248.72,713.72 550.26,286.53" />
      <path d="M487.44,713.72l35.43-50.26c5.53-7.79,14.57-12.56,24.37-12.56h191.48v62.82H487.44z" />
    </g>
  </svg>
);

export default ZhipuIcon;
