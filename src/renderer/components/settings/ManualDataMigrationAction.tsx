import React from 'react';

interface ManualDataMigrationActionProps {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

export default function ManualDataMigrationAction({
  children,
  onClick,
  disabled = false,
}: ManualDataMigrationActionProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 self-start rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98] sm:self-auto"
    >
      {children}
    </button>
  );
}
