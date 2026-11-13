import React from 'react';

import { ShortcutAction } from '../../config';
import SidebarSearchIcon from '../icons/SidebarSearchIcon';
import Tooltip from '../ui/Tooltip';
import {
  SIDEBAR_HEADER_BUTTON_FOCUS_CLASS_NAME,
  SIDEBAR_HEADER_TOOLTIP_BUBBLE_CLASS_NAME,
} from './sidebarHeaderTooltip';
import { useShortcutHint } from './useShortcutHint';

interface SidebarTaskSearchButtonProps {
  label: string;
  onClick: () => void;
  className?: string;
}

const SidebarTaskSearchButton: React.FC<SidebarTaskSearchButtonProps> = ({
  label,
  onClick,
  className = '',
}) => {
  const shortcutHint = useShortcutHint(ShortcutAction.Search);
  return (
    <Tooltip
      className={`shrink-0 ${className}`}
      bubbleClassName={SIDEBAR_HEADER_TOOLTIP_BUBBLE_CLASS_NAME}
      content={(
        <span className="inline-flex items-center gap-1.5">
          <span>{label}</span>
          {shortcutHint && <span className="text-white/55">{shortcutHint}</span>}
        </span>
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={`group inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-foreground/80 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04] ${SIDEBAR_HEADER_BUTTON_FOCUS_CLASS_NAME} ${className}`}
        aria-label={label}
      >
        <SidebarSearchIcon className="sidebar-search-icon-flip h-[18px] w-[18px]" />
      </button>
    </Tooltip>
  );
};

export default SidebarTaskSearchButton;
