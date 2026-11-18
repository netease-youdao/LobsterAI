import React from 'react';

import MarkdownContent from '../MarkdownContent';
import { USER_MESSAGE_TEXT_ATTRIBUTE } from './userMessageCollapse';

const MARKDOWN_IMAGE_LINE_RE = /^\s*!\[[^\]]*\]\((?:file|localfile|https?|data|blob):[^)]+\)\s*$/i;

// Kept out of conversation search: the chips are not part of the message text.
const renderLeading = (leading: React.ReactNode): React.ReactNode => (
  <span data-cowork-search-exclude="true">{leading}</span>
);

/** Returns true when a text block was rendered. */
const flushText = (
  nodes: React.ReactNode[],
  buffer: string[],
  keyPrefix: string,
  leading?: React.ReactNode,
): boolean => {
  if (buffer.length === 0) return false;
  const text = buffer.join('\n');
  buffer.length = 0;
  if (!text.trim()) return false;
  nodes.push(
    <div
      key={`${keyPrefix}-${nodes.length}`}
      {...{ [USER_MESSAGE_TEXT_ATTRIBUTE]: true }}
      className="whitespace-pre-wrap break-words text-foreground/90"
    >
      {leading ? renderLeading(leading) : null}
      {text}
    </div>
  );
  return true;
};

const renderUserMessageParts = (
  content: string,
  onImageClick?: (image: { src: string; alt?: string | null }) => void,
  leading?: React.ReactNode,
): React.ReactNode[] => {
  const nodes: React.ReactNode[] = [];
  const textBuffer: string[] = [];
  let leadingPlaced = !leading;
  // Leading chips flow into the first line when the message opens with text.
  const flush = (keyPrefix: string) => {
    const leadingForBlock = !leadingPlaced && nodes.length === 0 ? leading : undefined;
    if (flushText(nodes, textBuffer, keyPrefix, leadingForBlock) && leadingForBlock) {
      leadingPlaced = true;
    }
  };

  content.split('\n').forEach((line, index) => {
    if (!MARKDOWN_IMAGE_LINE_RE.test(line)) {
      textBuffer.push(line);
      return;
    }

    flush(`text-${index}`);
    nodes.push(
      <MarkdownContent
        key={`image-${index}`}
        content={line.trim()}
        spacing="compact"
        className="max-w-none"
        onImageClick={onImageClick}
      />
    );
  });

  flush('text-tail');
  if (!leadingPlaced) {
    nodes.unshift(<div key="leading" className="mb-1">{renderLeading(leading)}</div>);
  }
  return nodes;
};

interface UserMessageContentProps {
  content: string;
  className?: string;
  onImageClick?: (image: { src: string; alt?: string | null }) => void;
  /** Inline elements (e.g. skill chips) placed before the first line of text. */
  leading?: React.ReactNode;
}

const UserMessageContent: React.FC<UserMessageContentProps> = ({
  content,
  className = '',
  onImageClick,
  leading,
}) => {
  return (
    <div className={`min-w-0 max-w-full text-markdown-body-compact ${className}`}>
      {renderUserMessageParts(content, onImageClick, leading)}
    </div>
  );
};

export default UserMessageContent;
