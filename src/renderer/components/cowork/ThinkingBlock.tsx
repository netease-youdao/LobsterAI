import { ChevronRightIcon, LightBulbIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';
import {
  bucketLength,
  getMessageLineCount,
  reportConversationBlockAction,
} from './conversationAnalytics';

const ThinkingBlock: React.FC<{
  message: CoworkMessage;
  mapDisplayText?: (value: string) => string;
}> = ({ message, mapDisplayText }) => {
  const isCurrentlyStreaming = Boolean(message.metadata?.isStreaming);
  const [isExpanded, setIsExpanded] = useState(isCurrentlyStreaming);
  const displayContent = mapDisplayText ? mapDisplayText(message.content) : message.content;
  const handleToggleExpanded = () => {
    const nextExpanded = !isExpanded;
    reportConversationBlockAction({
      actionType: nextExpanded ? 'thinking_expand' : 'thinking_collapse',
      blockType: 'thinking',
      params: {
        isStreaming: isCurrentlyStreaming,
        thinkingLength: displayContent.length,
        thinkingLengthBucket: bucketLength(displayContent.length),
        thinkingLineCount: getMessageLineCount(displayContent),
      },
    });
    setIsExpanded(nextExpanded);
  };

  useEffect(() => {
    if (isCurrentlyStreaming) {
      setIsExpanded(true);
    } else {
      setIsExpanded(false);
    }
  }, [isCurrentlyStreaming]);

  return (
    <div className="rounded-lg border border-border bg-surface-sunken/50 overflow-hidden">
      <button
        onClick={handleToggleExpanded}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised/50 transition-colors"
      >
        <LightBulbIcon className="h-3.5 w-3.5 text-secondary flex-shrink-0" />
        <span className="text-xs font-medium text-secondary">
          {i18nService.t('reasoning')}
        </span>
        {isCurrentlyStreaming && (
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
        )}
        <ChevronRightIcon
          className={`h-3 w-3 text-secondary/60 flex-shrink-0 ml-auto transition-transform duration-200 ${
            isExpanded ? 'rotate-90' : ''
          }`}
        />
      </button>
      {isExpanded && (
        <div className="px-3 pb-3 max-h-[300px] overflow-y-auto border-t border-border/50">
          <div className="text-xs leading-relaxed text-muted whitespace-pre-wrap pt-2">
            {displayContent}
          </div>
        </div>
      )}
    </div>
  );
};

export default ThinkingBlock;
