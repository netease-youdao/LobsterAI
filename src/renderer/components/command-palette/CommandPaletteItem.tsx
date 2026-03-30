import React from 'react';

interface CommandPaletteItemProps {
  icon?: React.ReactNode;
  label: string;
  shortcut?: string;
}

const CommandPaletteItem: React.FC<CommandPaletteItemProps> = ({ icon, label, shortcut }) => {
  return (
    <div className="flex items-center gap-2 w-full">
      {icon && (
        <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {icon}
        </span>
      )}
      <span className="flex-1 truncate">{label}</span>
      {shortcut && (
        <kbd className="ml-auto flex-shrink-0 text-xs px-1.5 py-0.5 rounded bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted text-claude-textSecondary dark:text-claude-darkTextSecondary font-mono">
          {shortcut}
        </kbd>
      )}
    </div>
  );
};

export default CommandPaletteItem;
