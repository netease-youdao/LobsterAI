/**
 * Tailwind CSS v3 plugin — bridges --lobster-* CSS variables into Tailwind utility classes.
 *
 * Usage in tailwind.config.js:
 *   plugins: [require('./src/renderer/theme/tailwind/plugin.cjs')]
 *
 * Provides: bg-background, text-foreground, bg-primary, border-border, etc.
 * Also provides legacy claude.* aliases for backward compatibility.
 *
 * Colors return the bare CSS variable when no Tailwind opacity modifier is
 * applied (e.g. bg-background, text-foreground), and only wrap in color-mix()
 * when a fractional opacity modifier is present (e.g. text-foreground/90,
 * bg-surface-raised/30). Keeping opaque colors off color-mix() ensures
 * Chromium computes standard rgb(...) values instead of CSS Color 4
 * color(srgb 0..1), which legacy rich-text paste parsers (such as POPO Docs)
 * misinterpret as near-black rgb(1, 1, 1) / rgb(0, 0, 0).
 */
const plugin = require('tailwindcss/plugin');

const withAlpha = (variable) => ({ opacityVariable, opacityValue }) => {
  if (opacityVariable !== undefined || opacityValue === undefined || opacityValue === '1') {
    return `var(${variable})`;
  }
  return `color-mix(in srgb, var(${variable}) calc(${opacityValue} * 100%), transparent)`;
};

module.exports = plugin(function () {
  // The plugin itself is a no-op; we only extend the theme below.
}, {
  theme: {
    extend: {
      colors: {
        // === Semantic theme colors (driven by CSS variables) ===
        background:    withAlpha('--lobster-background'),
        foreground:    withAlpha('--lobster-foreground'),
        primary: {
          DEFAULT:     withAlpha('--lobster-primary'),
          foreground:  withAlpha('--lobster-primary-foreground'),
          hover:       withAlpha('--lobster-primary-hover'),
          muted:       withAlpha('--lobster-primary-muted'),
          dark:        withAlpha('--lobster-primary-hover'),  // backward compat alias
        },
        action: {
          DEFAULT:     withAlpha('--lobster-action'),
          foreground:  withAlpha('--lobster-action-foreground'),
          hover:       withAlpha('--lobster-action-hover'),
        },
        accent: {
          DEFAULT:     withAlpha('--lobster-accent'),
          foreground:  withAlpha('--lobster-accent-foreground'),
        },
        surface: {
          DEFAULT:     withAlpha('--lobster-surface'),
          foreground:  withAlpha('--lobster-surface-foreground'),
          raised:      withAlpha('--lobster-surface-raised'),
          overlay:     withAlpha('--lobster-surface-overlay'),
          inset:       withAlpha('--lobster-surface-raised'),  // alias
        },
        'chat-user': {
          DEFAULT:     withAlpha('--lobster-chat-user'),
          foreground:  withAlpha('--lobster-chat-user-foreground'),
        },
        border: {
          DEFAULT:     withAlpha('--lobster-border'),
          subtle:      withAlpha('--lobster-border-subtle'),
          input:       withAlpha('--lobster-input-border'),
        },
        muted:         withAlpha('--lobster-text-muted'),
        destructive: {
          DEFAULT:     withAlpha('--lobster-destructive'),
          foreground:  withAlpha('--lobster-destructive-foreground'),
        },
        success:       withAlpha('--lobster-success'),
        warning:       withAlpha('--lobster-warning'),

        // === Legacy claude.* aliases (map to --lobster-* for backward compat) ===
        claude: {
          bg:                withAlpha('--lobster-background'),
          surface:           withAlpha('--lobster-surface'),
          surfaceHover:      withAlpha('--lobster-surface-raised'),
          surfaceMuted:      withAlpha('--lobster-surface-raised'),
          surfaceInset:      withAlpha('--lobster-surface-raised'),
          border:            withAlpha('--lobster-border'),
          borderLight:       withAlpha('--lobster-border-subtle'),
          text:              withAlpha('--lobster-text-primary'),
          textSecondary:     withAlpha('--lobster-text-secondary'),
          // dark.* aliases point to the same vars — theme handles light/dark
          darkBg:            withAlpha('--lobster-background'),
          darkSurface:       withAlpha('--lobster-surface'),
          darkSurfaceHover:  withAlpha('--lobster-surface-raised'),
          darkSurfaceMuted:  withAlpha('--lobster-surface-raised'),
          darkSurfaceInset:  withAlpha('--lobster-surface-raised'),
          darkBorder:        withAlpha('--lobster-border'),
          darkBorderLight:   withAlpha('--lobster-border-subtle'),
          darkText:          withAlpha('--lobster-text-primary'),
          darkTextSecondary: withAlpha('--lobster-text-secondary'),
          // Accent
          accent:            withAlpha('--lobster-primary'),
          accentHover:       withAlpha('--lobster-primary-hover'),
          accentLight:       withAlpha('--lobster-primary'),
          accentMuted:       withAlpha('--lobster-primary-muted'),
        },
        secondary: {
          DEFAULT: withAlpha('--lobster-text-secondary'),
          dark:    withAlpha('--lobster-border'),
        },
      },
      borderRadius: {
        theme: 'var(--lobster-radius)',
      },
    },
  },
});
