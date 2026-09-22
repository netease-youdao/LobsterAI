export const HighlightStatus = {
  Ready: 'ready', Loading: 'loading', Unavailable: 'unavailable', Unknown: 'unknown', TooLarge: 'too-large', Mismatch: 'mismatch',
} as const;
export type HighlightStatus = typeof HighlightStatus[keyof typeof HighlightStatus];
export const MAX_HIGHLIGHT_BYTES = 2_000_000;
export const MAX_HIGHLIGHT_CACHE_BYTES = 16 * 1024 * 1024;
export const MAX_HIGHLIGHT_CACHE_ENTRIES = 8;
