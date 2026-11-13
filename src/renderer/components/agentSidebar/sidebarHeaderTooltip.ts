// Solid fill: the theme overlay colour is nearly the sidebar's and reads as transparent here.
export const SIDEBAR_HEADER_TOOLTIP_BUBBLE_CLASS_NAME =
  'bg-[#262626] text-white dark:border dark:border-white/10 dark:bg-[#3a3a3a]';

// Keyboard focus ring for the sidebar header icon buttons. Without it the browser draws its
// own ring in the macOS accent colour; a fixed soft blue keeps it calm in every theme.
export const SIDEBAR_HEADER_BUTTON_FOCUS_CLASS_NAME =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/45 dark:focus-visible:ring-[#60A5FA]/55';
