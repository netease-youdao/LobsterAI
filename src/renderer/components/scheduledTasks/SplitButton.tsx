import React, { useRef, useState, useEffect } from 'react';
import { ChevronDownIcon, ArrowUpTrayIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';

export interface DropdownMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

interface DropdownMenuButtonProps {
  label: string;
  icon?: React.ReactNode;
  items: DropdownMenuItem[];
  disabled?: boolean;
  className?: string;
}

/**
 * A single button that opens a dropdown menu on click.
 * Replaces the old SplitButton (main action + chevron) with a simpler
 * unified trigger that lists all options in the dropdown.
 */
const DropdownMenuButton: React.FC<DropdownMenuButtonProps> = ({
  label,
  icon,
  items,
  disabled = false,
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div ref={containerRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen((v) => !v); }}
        className={`inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-lg border border-border bg-surface text-foreground transition-colors
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface-raised cursor-pointer'}`}
      >
        {icon && <span className="w-4 h-4 flex-shrink-0">{icon}</span>}
        <span>{label}</span>
        <ChevronDownIcon
          className={`w-3.5 h-3.5 text-secondary transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 min-w-[9rem] rounded-lg shadow-lg bg-surface border border-border z-50 py-1 overflow-hidden">
          {items.map((item, idx) => (
            <button
              key={idx}
              type="button"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap transition-colors"
            >
              {item.icon && <span className="w-4 h-4 flex-shrink-0 text-secondary">{item.icon}</span>}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default DropdownMenuButton;

// Keep the old export name as an alias so other imports aren't broken
export { DropdownMenuButton as SplitButton };
export type { DropdownMenuButtonProps as SplitButtonProps };

// Re-export icon shortcuts for use at call site
export { ArrowUpTrayIcon, ArrowDownTrayIcon };