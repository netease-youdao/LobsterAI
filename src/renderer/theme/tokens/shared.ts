/**
 * Shared token defaults — values identical across most themes.
 *
 * Individual themes spread these and override only what differs.
 */
import type { ThemeTokens } from '../themes/types';

export const SHARED_TOKENS: Pick<
  ThemeTokens,
  'destructive' | 'destructive-foreground' | 'success' | 'warning' | 'radius'
> = {
  'destructive':            '#ef4444',
  'destructive-foreground': '#ffffff',
  'success':                '#22c55e',
  'warning':                '#f59e0b',
  'radius':                 '0.5rem',
};
