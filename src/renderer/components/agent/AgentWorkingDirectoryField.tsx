import { FolderIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import { getCompactFolderName } from '../../utils/path';
import FolderSelectorPopover from '../cowork/FolderSelectorPopover';

interface AgentWorkingDirectoryFieldProps {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
  bordered?: boolean;
  placement?: 'top' | 'bottom';
  hideLabel?: boolean;
  hideHint?: boolean;
  placeholder?: string;
}

const truncatePath = (value: string, maxLength = 72, placeholder?: string): string => {
  if (!value.trim()) return placeholder || i18nService.t('noFolderSelected');
  return getCompactFolderName(value, maxLength) || value;
};

const AgentWorkingDirectoryField: React.FC<AgentWorkingDirectoryFieldProps> = ({
  value,
  onChange,
  compact = false,
  bordered = false,
  placement,
  hideLabel = false,
  hideHint = false,
  placeholder,
}) => {
  const [showFolderMenu, setShowFolderMenu] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleFolderSelect = (path: string) => {
    onChange(path);
    setShowFolderMenu(false);
  };

  if (compact) {
    const hasValue = value.trim().length > 0;
    return (
      <div className="relative min-w-0">
        <div
          className={`inline-flex h-8 min-w-0 max-w-[232px] items-center rounded-lg transition-colors ${
            bordered
              ? 'border border-border bg-surface text-xs hover:bg-surface-raised'
              : 'bg-surface-raised/70 text-sm hover:bg-surface-raised'
          } ${showFolderMenu ? 'text-foreground' : 'text-secondary'}`}
        >
          <button
            ref={buttonRef}
            type="button"
            title={hasValue ? value : i18nService.t('noFolderSelected')}
            aria-label={i18nService.t('agentDefaultWorkingDirectory')}
            onClick={() => setShowFolderMenu((open) => !open)}
            className="inline-flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-lg pl-2.5 pr-2"
          >
            <FolderIcon className={`${bordered ? 'h-3.5 w-3.5' : 'h-4 w-4'} flex-shrink-0 text-secondary`} />
            <span className={`truncate ${hasValue ? 'text-foreground' : 'text-secondary'}`}>
              {truncatePath(value, 36, placeholder)}
            </span>
          </button>
          {hasValue && (
            <button
              type="button"
              aria-label={i18nService.t('clear')}
              title={i18nService.t('clear')}
              onClick={() => onChange('')}
              className="h-full w-7 flex-shrink-0 inline-flex items-center justify-center rounded-r-lg text-secondary/75 hover:text-foreground transition-colors"
            >
              <XMarkIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <FolderSelectorPopover
          isOpen={showFolderMenu}
          onClose={() => setShowFolderMenu(false)}
          onSelectFolder={handleFolderSelect}
          anchorRef={buttonRef as React.RefObject<HTMLElement>}
          portal
          placement={placement ?? 'top'}
        />
      </div>
    );
  }

  return (
    <div className="relative">
      {!hideLabel && (
        <label className="block text-sm font-medium text-secondary mb-1">
          {i18nService.t('agentDefaultWorkingDirectory')}
        </label>
      )}
      <div className="flex items-center gap-2">
        <button
          ref={buttonRef}
          type="button"
          title={value.trim() || placeholder || i18nService.t('noFolderSelected')}
          onClick={() => setShowFolderMenu((open) => !open)}
          className="min-w-0 flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-transparent text-foreground text-sm hover:bg-surface-raised transition-colors"
        >
          <FolderIcon className="h-4 w-4 flex-shrink-0 text-secondary" />
          <span className={`flex-1 truncate text-left ${value.trim() ? '' : 'text-secondary'}`}>
            {truncatePath(value, 72, placeholder)}
          </span>
        </button>
        {value.trim() && (
          <button
            type="button"
            aria-label={i18nService.t('clear')}
            onClick={() => onChange('')}
            className="h-9 w-9 flex-shrink-0 inline-flex items-center justify-center rounded-lg border border-border text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
          >
            <XMarkIcon className="h-3.5 w-3.5 text-secondary" />
          </button>
        )}
      </div>
      {!hideHint && (
        <p className="mt-1 text-xs text-secondary/70">
          {i18nService.t('agentDefaultWorkingDirectoryHint')}
        </p>
      )}
      <FolderSelectorPopover
        isOpen={showFolderMenu}
        onClose={() => setShowFolderMenu(false)}
        onSelectFolder={handleFolderSelect}
        anchorRef={buttonRef as React.RefObject<HTMLElement>}
        portal
      />
    </div>
  );
};

export default AgentWorkingDirectoryField;
