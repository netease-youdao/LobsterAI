import type { RefObject } from 'react';
import type { CoworkPromptInputRef } from '../cowork/CoworkPromptInput';

export interface MessageContext {
  messageId: string;
  messageRole: 'user' | 'assistant';
  sessionId: string;
}

export interface SelectionAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  handler: (selectedText: string, context?: MessageContext) => void;
  /** @default true */
  clearSelectionAfter?: boolean;
}

/** x/y are viewport coordinates for position: fixed */
export interface ToolbarPosition {
  x: number;
  y: number;
  visible: boolean;
}

export interface UseTextSelectionReturn {
  selectedText: string;
  position: ToolbarPosition;
  clearSelection: () => void;
}

export interface SelectionToolbarProps {
  containerRef: RefObject<HTMLElement | null>;
  scrollContainerRef: RefObject<HTMLElement | null>;
  promptInputRef: RefObject<CoworkPromptInputRef | null>;
  sessionId: string;
  extraActions?: SelectionAction[];
}

export type ActionType = 'builtin' | 'custom';

export interface ActionConfig {
  id: string;           // builtin: 'copy'|'quote'|'explain'|'translate'|'ask'; custom: UUID
  type: ActionType;
  enabled: boolean;
  order: number;
  label?: string;       // custom actions only
  prompt?: string;      // custom actions only, must contain {{SELECTED_CONTENT}}
  icon?: string;        // custom actions only
}

export interface SelectionToolbarConfig {
  version: 1;
  actions: ActionConfig[] | null; // null = use defaults
}
