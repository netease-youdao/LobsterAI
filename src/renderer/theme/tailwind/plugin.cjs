/**
 * Tailwind CSS v3 plugin — bridges --lobster-* CSS variables into Tailwind utility classes.
 *
 * Usage in tailwind.config.js:
 *   plugins: [require('./src/renderer/theme/tailwind/plugin.cjs')]
 *
 * Provides: bg-background, text-foreground, bg-primary, border-border, etc.
 * Also provides legacy claude.* aliases for backward compatibility.
 */
const plugin = require('tailwindcss/plugin');

module.exports = plugin(function () {
  // The plugin itself is a no-op; we only extend the theme below.
}, {
  theme: {
    extend: {
      colors: {
        // === Semantic theme colors (driven by CSS variables) ===
        background:    'var(--lobster-background)',
        foreground:    'var(--lobster-foreground)',
        primary: {
          DEFAULT:     'var(--lobster-primary)',
          foreground:  'var(--lobster-primary-foreground)',
          hover:       'var(--lobster-primary-hover)',
          muted:       'var(--lobster-primary-muted)',
          dark:        'var(--lobster-primary-hover)',  // backward compat alias
        },
        accent: {
          DEFAULT:     'var(--lobster-accent)',
          foreground:  'var(--lobster-accent-foreground)',
        },
        surface: {
          DEFAULT:     'var(--lobster-surface)',
          foreground:  'var(--lobster-surface-foreground)',
          raised:      'var(--lobster-surface-raised)',
          overlay:     'var(--lobster-surface-overlay)',
          inset:       'var(--lobster-surface-raised)',  // alias
        },
        border: {
          DEFAULT:     'var(--lobster-border)',
          subtle:      'var(--lobster-border-subtle)',
          input:       'var(--lobster-input-border)',
        },
        muted:         'var(--lobster-text-muted)',
        destructive: {
          DEFAULT:     'var(--lobster-destructive)',
          foreground:  'var(--lobster-destructive-foreground)',
        },
        success:       'var(--lobster-success)',
        warning:       'var(--lobster-warning)',

        // === Legacy claude.* aliases (map to --lobster-* for backward compat) ===
        claude: {
          bg:                'var(--lobster-background)',
          surface:           'var(--lobster-surface)',
          surfaceHover:      'var(--lobster-surface-raised)',
          surfaceMuted:      'var(--lobster-surface-raised)',
          surfaceInset:      'var(--lobster-surface-raised)',
          border:            'var(--lobster-border)',
          borderLight:       'var(--lobster-border-subtle)',
          text:              'var(--lobster-text-primary)',
          textSecondary:     'var(--lobster-text-secondary)',
          // dark.* aliases point to the same vars — theme handles light/dark
          darkBg:            'var(--lobster-background)',
          darkSurface:       'var(--lobster-surface)',
          darkSurfaceHover:  'var(--lobster-surface-raised)',
          darkSurfaceMuted:  'var(--lobster-surface-raised)',
          darkSurfaceInset:  'var(--lobster-surface-raised)',
          darkBorder:        'var(--lobster-border)',
          darkBorderLight:   'var(--lobster-border-subtle)',
          darkText:          'var(--lobster-text-primary)',
          darkTextSecondary: 'var(--lobster-text-secondary)',
          // Accent
          accent:            'var(--lobster-primary)',
          accentHover:       'var(--lobster-primary-hover)',
          accentLight:       'var(--lobster-primary)',
          accentMuted:       'var(--lobster-primary-muted)',
        },
        secondary: {
          DEFAULT: 'var(--lobster-text-secondary)',
          dark:    'var(--lobster-border)',
        },
      },
      borderRadius: {
        theme: 'var(--lobster-radius)',
      },
    },
  },
});
