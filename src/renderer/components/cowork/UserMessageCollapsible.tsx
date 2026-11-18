import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import {
  countUserMessageLines,
  shouldCollapseUserMessage,
  USER_MESSAGE_COLLAPSED_ATTRIBUTE,
  USER_MESSAGE_COLLAPSED_HEIGHT_PX,
  USER_MESSAGE_EXPAND_EVENT,
  USER_MESSAGE_TEXT_ATTRIBUTE,
} from './userMessageCollapse';

interface UserMessageCollapsibleProps {
  children: React.ReactNode;
}

const COLLAPSED_FADE_MASK = 'linear-gradient(to bottom, black calc(100% - 48px), transparent)';

/**
 * Clips a long user message to a fixed height with a fade and a show-more
 * toggle. Short messages render untouched.
 */
const UserMessageCollapsible: React.FC<UserMessageCollapsibleProps> = ({ children }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isCollapsible, setIsCollapsible] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [lineCount, setLineCount] = useState(0);
  const regionId = useId();

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;
    const measure = () => {
      setIsCollapsible(shouldCollapseUserMessage(content.offsetHeight));
      setLineCount(Array.from(content.querySelectorAll(`[${USER_MESSAGE_TEXT_ATTRIBUTE}]`))
        .reduce((total, block) => total + countUserMessageLines(
          block.getBoundingClientRect().height,
          Number.parseFloat(getComputedStyle(block).lineHeight),
        ), 0));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // Conversation search asks a collapsed message to open when its active match
  // sits in the clipped part.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const handleExpand = () => setIsExpanded(true);
    root.addEventListener(USER_MESSAGE_EXPAND_EVENT, handleExpand);
    return () => root.removeEventListener(USER_MESSAGE_EXPAND_EVENT, handleExpand);
  }, []);

  const handleToggle = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (isExpanded) {
      // Collapsing a long message can leave the reader far below it.
      requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'nearest' }));
    }
    setIsExpanded(!isExpanded);
  }, [isExpanded]);

  const isCollapsed = isCollapsible && !isExpanded;
  const expandLabel = lineCount > 1
    ? i18nService.t('coworkUserMessageExpandLines').replace('{count}', String(lineCount))
    : i18nService.t('coworkUserMessageExpand');

  return (
    <div ref={rootRef} {...{ [USER_MESSAGE_COLLAPSED_ATTRIBUTE]: isCollapsed ? 'true' : 'false' }}>
      <div
        id={regionId}
        className={isCollapsed ? 'overflow-hidden' : undefined}
        style={isCollapsed
          ? {
            maxHeight: USER_MESSAGE_COLLAPSED_HEIGHT_PX,
            maskImage: COLLAPSED_FADE_MASK,
            WebkitMaskImage: COLLAPSED_FADE_MASK,
          }
          : undefined}
      >
        <div ref={contentRef}>
          {children}
        </div>
      </div>
      {isCollapsible && (
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={isExpanded}
          aria-controls={regionId}
          className="mt-1 -ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-secondary transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]"
        >
          <span>{isExpanded ? i18nService.t('coworkUserMessageCollapse') : expandLabel}</span>
          {isExpanded
            ? <ChevronUpIcon className="h-3.5 w-3.5" />
            : <ChevronDownIcon className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
};

export default UserMessageCollapsible;
