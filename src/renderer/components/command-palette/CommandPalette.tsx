import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Command } from 'cmdk';
import { commandRegistry } from '@/services/commandRegistry';
import { i18nService } from '@/services/i18n';
import type { Command as CommandDef, CommandGroup } from '@/services/commandRegistry';
import CommandPaletteItem from './CommandPaletteItem';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

const CommandPalette: React.FC<CommandPaletteProps> = ({ open, onClose }) => {
  const [search, setSearch] = useState('');
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setSearch('');
    }
  }, [open]);

  const handleSelect = useCallback((cmd: CommandDef) => {
    cmd.action();
    if (cmd.closeOnSelect !== false) {
      onClose();
    }
  }, [onClose]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) {
      onClose();
    }
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [onClose]);

  if (!open) return null;

  const allCommands = commandRegistry.getAll();
  const groups = commandRegistry.getGroups();

  const groupedCommands = new Map<string, CommandDef[]>();
  for (const cmd of allCommands) {
    const list = groupedCommands.get(cmd.group) ?? [];
    list.push(cmd);
    groupedCommands.set(cmd.group, list);
  }

  const activeGroups = groups.filter(g => groupedCommands.has(g.id));

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50"
      onClick={handleBackdropClick}
    >
      <div className="w-full max-w-lg mx-4 rounded-xl overflow-hidden shadow-2xl border border-claude-border dark:border-claude-darkBorder bg-claude-bg dark:bg-claude-darkBg">
        <Command
          onKeyDown={handleKeyDown}
          className="flex flex-col"
          label={i18nService.t('commandPalettePlaceholder')}
        >
          <div className="flex items-center border-b border-claude-border dark:border-claude-darkBorder px-3">
            <MagnifyingGlassIcon className="w-4 h-4 mr-2 text-claude-textSecondary dark:text-claude-darkTextSecondary flex-shrink-0" />
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder={i18nService.t('commandPalettePlaceholder')}
              className="flex-1 h-11 bg-transparent text-sm text-claude-text dark:text-claude-darkText placeholder:text-claude-textSecondary dark:placeholder:text-claude-darkTextSecondary outline-none"
              autoFocus
            />
          </div>

          <Command.List className="max-h-72 overflow-y-auto p-1.5">
            <Command.Empty className="py-6 text-center text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('commandPaletteNoResults')}
            </Command.Empty>

            {activeGroups.map((group: CommandGroup) => {
              const cmds = groupedCommands.get(group.id);
              if (!cmds || cmds.length === 0) return null;

              return (
                <Command.Group
                  key={group.id}
                  heading={group.label}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-claude-textSecondary [&_[cmdk-group-heading]]:dark:text-claude-darkTextSecondary"
                >
                  {cmds.map((cmd: CommandDef) => (
                    <Command.Item
                      key={cmd.id}
                      value={cmd.id}
                      keywords={cmd.keywords}
                      onSelect={() => handleSelect(cmd)}
                      className="flex items-center px-2 py-1.5 rounded-lg text-sm text-claude-text dark:text-claude-darkText cursor-pointer aria-selected:bg-claude-accent/10 aria-selected:text-claude-accent dark:aria-selected:bg-claude-accent/20"
                    >
                      <CommandPaletteItem
                        icon={cmd.icon}
                        label={cmd.label}
                        shortcut={cmd.shortcut}
                      />
                    </Command.Item>
                  ))}
                </Command.Group>
              );
            })}
          </Command.List>
        </Command>
      </div>
    </div>
  );
};

const MagnifyingGlassIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className={className}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
    />
  </svg>
);

export default CommandPalette;
