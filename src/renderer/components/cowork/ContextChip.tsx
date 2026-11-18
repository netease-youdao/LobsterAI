import React from 'react';

// One look for skills, kits and modes wherever they sit next to prompt text:
// the composer's inline chips and the sent user message.

export const ContextChipTone = {
  /** A composer mode (plan, goal, steer): tinted, it changes what the input means. */
  Mode: 'mode',
  /** A capability attached to the prompt (skill, kit): neutral, like a token. */
  Reference: 'reference',
} as const;
export type ContextChipTone = typeof ContextChipTone[keyof typeof ContextChipTone];

/** Set on an ancestor to pin the chip height in whole pixels; it defaults to 1.6em. */
export const CONTEXT_CHIP_HEIGHT_VAR = '--context-chip-height';

// Sized in em, so a chip takes the font size of the text it sits in.
// leading-[1.4], not leading-none: the truncating label would clip descenders.
export const CONTEXT_CHIP_CLASS = 'inline-flex h-[var(--context-chip-height,1.6em)] max-w-[240px] items-center gap-[0.3em] rounded-lg border pl-[0.4em] pr-[0.55em] font-normal leading-[1.4] text-foreground';

export const CONTEXT_CHIP_TONE_CLASS: Record<ContextChipTone, string> = {
  [ContextChipTone.Reference]: 'border-black/[0.1] bg-surface dark:border-white/[0.12]',
  [ContextChipTone.Mode]: 'border-primary/15 bg-primary-muted',
};

export const CONTEXT_CHIP_ICON_CLASS = 'h-[1em] w-[1em] shrink-0';

export const CONTEXT_CHIP_ICON_TONE_CLASS: Record<ContextChipTone, string> = {
  [ContextChipTone.Reference]: 'text-secondary',
  [ContextChipTone.Mode]: 'text-primary',
};

/** A read-only chip, e.g. the skills a sent message used. */
const ContextChip: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tone?: ContextChipTone;
  title?: string;
  className?: string;
}> = ({ icon: Icon, label, tone = ContextChipTone.Reference, title, className = '' }) => (
  <span
    className={`${CONTEXT_CHIP_CLASS} ${CONTEXT_CHIP_TONE_CLASS[tone]} ${className}`}
    title={title}
  >
    <Icon className={`${CONTEXT_CHIP_ICON_CLASS} ${CONTEXT_CHIP_ICON_TONE_CLASS[tone]}`} />
    <span className="min-w-0 truncate">{label}</span>
  </span>
);

export default ContextChip;
