import type { CSSProperties } from 'react';

export default function FollowUpSuggestionHint({ text, className, style }: {
  text: string; className: string; style?: CSSProperties;
}) {
  return <div aria-hidden="true" data-follow-up-suggestion className="pointer-events-none absolute inset-0 overflow-hidden">
    <div className={`${className} flex w-full items-start gap-2`} style={style}>
      <span className="min-w-0 flex-1 truncate text-secondary/50 dark:text-foregroundSecondary/80">{text}</span>
      <kbd className="mt-0.5 shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-muted">Tab</kbd>
    </div>
  </div>;
}
