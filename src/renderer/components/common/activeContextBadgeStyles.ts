// leading-5 (not leading-none): the label span truncates with overflow-hidden,
// which clips descenders (g/y/p) when the line box equals the font size.
export const ACTIVE_CONTEXT_BADGE_BUTTON_CLASS = 'group inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-md bg-primary-muted px-2.5 text-[13px] font-normal leading-5 text-foreground transition-all hover:bg-primary/15 hover:ring-1 hover:ring-primary/30';

export const ACTIVE_CONTEXT_BADGE_ICON_WRAP_CLASS = 'relative flex h-4 w-4 shrink-0 items-center justify-center rounded-sm transition-colors group-hover:bg-primary/15';

export const ACTIVE_CONTEXT_BADGE_ICON_CLASS = 'h-3.5 w-3.5 text-primary transition-opacity group-hover:opacity-0';

export const ACTIVE_CONTEXT_BADGE_REMOVE_ICON_CLASS = 'absolute h-3 w-3 text-primary opacity-0 transition-opacity group-hover:opacity-100';
