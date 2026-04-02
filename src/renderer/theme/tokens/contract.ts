/**
 * Token Contract — defines all semantic variables a theme must provide.
 *
 * Naming: --lobster-{category}-{name}
 * Convention: shadcn/ui background/foreground pairing + Radix 12-step gray scale
 *
 * Every theme (ThemeDefinition.tokens) must supply a value for each key.
 */
export const TOKEN_CONTRACT = {
  // ── Brand ──
  'primary':            '--lobster-primary',
  'primary-foreground': '--lobster-primary-foreground',
  'primary-hover':      '--lobster-primary-hover',
  'primary-muted':      '--lobster-primary-muted',

  // ── Accent ──
  'accent':             '--lobster-accent',
  'accent-foreground':  '--lobster-accent-foreground',

  // ── Surface / Background ──
  'background':         '--lobster-background',
  'foreground':         '--lobster-foreground',
  'surface':            '--lobster-surface',
  'surface-foreground': '--lobster-surface-foreground',
  'surface-raised':     '--lobster-surface-raised',
  'surface-overlay':    '--lobster-surface-overlay',

  // ── Chat bubbles ──
  'chat-user':              '--lobster-chat-user',
  'chat-user-foreground':   '--lobster-chat-user-foreground',
  'chat-bot':               '--lobster-chat-bot',
  'chat-bot-foreground':    '--lobster-chat-bot-foreground',

  // ── Text hierarchy ──
  'text-primary':       '--lobster-text-primary',
  'text-secondary':     '--lobster-text-secondary',
  'text-muted':         '--lobster-text-muted',

  // ── Borders ──
  'border':             '--lobster-border',
  'border-subtle':      '--lobster-border-subtle',
  'input-border':       '--lobster-input-border',

  // ── Scrollbar ──
  'scroll-thumb':       '--lobster-scroll-thumb',
  'scroll-thumb-hover': '--lobster-scroll-thumb-hover',

  // ── Decorative gradients ──
  'gradient-1':         '--lobster-gradient-1',
  'gradient-2':         '--lobster-gradient-2',

  // ── Status ──
  'destructive':            '--lobster-destructive',
  'destructive-foreground': '--lobster-destructive-foreground',
  'success':                '--lobster-success',
  'warning':                '--lobster-warning',

  // ── Gray scale 11 steps (gray-1=lightest → gray-11=darkest, all themes) ──
  'gray-1':  '--lobster-gray-1',
  'gray-2':  '--lobster-gray-2',
  'gray-3':  '--lobster-gray-3',
  'gray-4':  '--lobster-gray-4',
  'gray-5':  '--lobster-gray-5',
  'gray-6':  '--lobster-gray-6',
  'gray-7':  '--lobster-gray-7',
  'gray-8':  '--lobster-gray-8',
  'gray-9':  '--lobster-gray-9',
  'gray-10': '--lobster-gray-10',
  'gray-11': '--lobster-gray-11',

  // ── Radius ──
  'radius':  '--lobster-radius',
} as const;

export type TokenName = keyof typeof TOKEN_CONTRACT;
export type CSSVarName = (typeof TOKEN_CONTRACT)[TokenName];

/** All token keys as an array */
export const TOKEN_NAMES = Object.keys(TOKEN_CONTRACT) as TokenName[];
