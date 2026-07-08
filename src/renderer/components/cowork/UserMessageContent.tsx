import React from 'react';

import MarkdownContent from '../MarkdownContent';

const MARKDOWN_IMAGE_LINE_RE = /^\s*!\[[^\]]*\]\((?:file|localfile|https?|data|blob):[^)]+\)\s*$/i;

const flushText = (
  nodes: React.ReactNode[],
  buffer: string[],
  keyPrefix: string,
): void => {
  if (buffer.length === 0) return;
  const text = buffer.join('\n');
  buffer.length = 0;
  if (!text.trim()) return;
  nodes.push(
    <div
      key={`${keyPrefix}-${nodes.length}`}
      className="whitespace-pre-wrap break-words text-foreground/90"
    >
      {text}
    </div>
  );
};

const renderUserMessageParts = (
  content: string,
  onImageClick?: (image: { src: string; alt?: string | null }) => void,
): React.ReactNode[] => {
  const nodes: React.ReactNode[] = [];
  const textBuffer: string[] = [];

  content.split('\n').forEach((line, index) => {
    if (!MARKDOWN_IMAGE_LINE_RE.test(line)) {
      textBuffer.push(line);
      return;
    }

    flushText(nodes, textBuffer, `text-${index}`);
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

  flushText(nodes, textBuffer, 'text-tail');
  return nodes;
};

interface UserMessageContentProps {
  content: string;
  className?: string;
  onImageClick?: (image: { src: string; alt?: string | null }) => void;
}

const UserMessageContent: React.FC<UserMessageContentProps> = ({
  content,
  className = '',
  onImageClick,
}) => {
  return (
    <div className={`min-w-0 max-w-full text-markdown-body-compact ${className}`}>
      {renderUserMessageParts(content, onImageClick)}
    </div>
  );
};

export default UserMessageContent;
