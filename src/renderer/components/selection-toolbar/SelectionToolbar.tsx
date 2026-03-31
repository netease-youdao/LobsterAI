import React, { useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { SelectionToolbarProps, SelectionAction } from './types';
import { useTextSelection } from './useTextSelection';
import { resolveActions } from './selectionActions';
import { useSelectionToolbarConfig } from './useSelectionToolbarConfig';

const SelectionToolbar: React.FC<SelectionToolbarProps> = ({
  containerRef,
  scrollContainerRef,
  promptInputRef,
  sessionId: _sessionId,
  extraActions,
}) => {
  const { selectedText, position, clearSelection } = useTextSelection(
    containerRef,
    scrollContainerRef,
  );

  const { config } = useSelectionToolbarConfig();

  const resolved = useMemo(
    () => resolveActions(config, promptInputRef),
    [config, promptInputRef],
  );
  const actions: SelectionAction[] = extraActions ? [...resolved, ...extraActions] : resolved;

  const handleAction = (action: SelectionAction) => {
    action.handler(selectedText);
    if (action.clearSelectionAfter ?? true) {
      clearSelection();
    }
  };

  if (!position.visible || actions.length === 0) return null;

  return createPortal(
    <div
      role="toolbar"
      data-selection-toolbar
      onMouseDown={(e) => e.preventDefault()}
      className="fixed z-[110] flex items-center gap-0.5 rounded-lg px-1 py-1
        bg-white dark:bg-claude-darkSurface
        border border-claude-border dark:border-claude-darkBorder
        shadow-lg
        animate-fade-in"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translateX(-50%)',
      }}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          onClick={() => handleAction(action)}
          className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs
            text-claude-textSecondary dark:text-claude-darkTextSecondary
            hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover
            hover:text-claude-text dark:hover:text-claude-darkText
            transition-colors whitespace-nowrap"
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
};

export default SelectionToolbar;
