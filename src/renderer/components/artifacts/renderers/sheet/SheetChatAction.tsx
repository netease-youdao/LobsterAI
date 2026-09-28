import React from 'react';

import type { ChatActionProps } from '@/services/sheet/sheetChatAction';

import SelectedTextIcon from '../../../icons/SelectedTextIcon';

/** The chat's selected-text icon at full strength, sized like Univer's own menu icons (1em). */
export function SheetAddToChatIcon({ className, style }: { className?: string; style?: React.CSSProperties }): React.ReactElement {
  return (
    <span className={`lobster-sheet-chat-icon${className ? ` ${className}` : ''}`} style={style} aria-hidden="true">
      <SelectedTextIcon />
    </span>
  );
}

/** "Add to chat" beside a selected range; pressing it keeps the grid's focus and selection. */
export function SheetChatAction({ popup }: { popup: { extraProps?: ChatActionProps } }): React.ReactElement | null {
  const { label, onAdd } = popup.extraProps ?? {};
  if (!label || !onAdd) return null;
  return (
    <button type="button" className="lobster-sheet-chat-action" onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
      onClick={event => { event.stopPropagation(); onAdd(); }}>
      <SheetAddToChatIcon />
      {label}
    </button>
  );
}
