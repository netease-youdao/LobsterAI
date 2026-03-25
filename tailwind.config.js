/** @type {import('tailwindcss').Config} */

function withOpacity(varName) {
  return `color-mix(in srgb, var(${varName}) calc(<alpha-value> * 100%), transparent)`;
}

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        claude: {
          bg: withOpacity('--claude-bg'),
          surface: withOpacity('--claude-surface'),
          surfaceHover: withOpacity('--claude-surfaceHover'),
          surfaceMuted: withOpacity('--claude-surfaceMuted'),
          surfaceInset: withOpacity('--claude-surfaceInset'),
          border: withOpacity('--claude-border'),
          borderLight: withOpacity('--claude-borderLight'),
          text: withOpacity('--claude-text'),
          textSecondary: withOpacity('--claude-textSecondary'),
          darkBg: withOpacity('--claude-darkBg'),
          darkSurface: withOpacity('--claude-darkSurface'),
          darkSurfaceHover: withOpacity('--claude-darkSurfaceHover'),
          darkSurfaceMuted: withOpacity('--claude-darkSurfaceMuted'),
          darkSurfaceInset: withOpacity('--claude-darkSurfaceInset'),
          darkBorder: withOpacity('--claude-darkBorder'),
          darkBorderLight: withOpacity('--claude-darkBorderLight'),
          darkText: withOpacity('--claude-darkText'),
          darkTextSecondary: withOpacity('--claude-darkTextSecondary'),
          accent: withOpacity('--claude-accent'),
          accentHover: withOpacity('--claude-accentHover'),
          accentLight: withOpacity('--claude-accentLight'),
          accentMuted: 'var(--claude-accentMuted)',
        },
        primary: {
          DEFAULT: 'var(--claude-accent)',
          dark: 'var(--claude-accentHover)'
        },
        secondary: {
          DEFAULT: 'var(--claude-textSecondary)',
          dark: 'var(--claude-darkBorder)'
        }
      },
      boxShadow: {
        subtle: '0 1px 2px rgba(0,0,0,0.05)',
        card: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
        elevated: '0 4px 12px rgba(0,0,0,0.1), 0 1px 3px rgba(0,0,0,0.04)',
        modal: '0 8px 30px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)',
        popover: '0 4px 20px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.05)',
        'glow-accent': '0 0 20px rgba(59,130,246,0.15)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-down': {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'fade-in-up': 'fade-in-up 0.25s ease-out',
        'fade-in-down': 'fade-in-down 0.2s ease-out',
        'scale-in': 'scale-in 0.2s ease-out',
        shimmer: 'shimmer 1.5s infinite',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      typography: {
        DEFAULT: {
          css: {
            color: 'var(--claude-text)',
            a: {
              color: 'var(--claude-accent)',
              '&:hover': {
                color: 'var(--claude-accentHover)',
              },
            },
            code: {
              color: 'var(--claude-text)',
              backgroundColor: 'var(--claude-surfaceHover)',
              padding: '0.2em 0.4em',
              borderRadius: '0.25rem',
              fontWeight: '400',
            },
            'code::before': {
              content: '""',
            },
            'code::after': {
              content: '""',
            },
            pre: {
              backgroundColor: 'var(--claude-surfaceHover)',
              color: 'var(--claude-text)',
              padding: '1em',
              borderRadius: '0.75rem',
              overflowX: 'auto',
            },
            blockquote: {
              borderLeftColor: 'var(--claude-accent)',
              color: 'var(--claude-textSecondary)',
            },
            h1: { color: 'var(--claude-text)' },
            h2: { color: 'var(--claude-text)' },
            h3: { color: 'var(--claude-text)' },
            h4: { color: 'var(--claude-text)' },
            strong: { color: 'var(--claude-text)' },
          },
        },
        dark: {
          css: {
            color: 'var(--claude-darkText)',
            a: {
              color: 'var(--claude-accentLight)',
              '&:hover': {
                color: '#93BBFD',
              },
            },
            code: {
              color: 'var(--claude-darkText)',
              backgroundColor: 'rgba(42, 46, 56, 0.5)',
              padding: '0.2em 0.4em',
              borderRadius: '0.25rem',
              fontWeight: '400',
            },
            pre: {
              backgroundColor: 'var(--claude-darkSurface)',
              color: 'var(--claude-darkText)',
              padding: '1em',
              borderRadius: '0.75rem',
              overflowX: 'auto',
            },
            blockquote: {
              borderLeftColor: 'var(--claude-accent)',
              color: 'var(--claude-darkTextSecondary)',
            },
            h1: { color: 'var(--claude-darkText)' },
            h2: { color: 'var(--claude-darkText)' },
            h3: { color: 'var(--claude-darkText)' },
            h4: { color: 'var(--claude-darkText)' },
            strong: { color: 'var(--claude-darkText)' },
          },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
