import React from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { PhotoIcon } from '@heroicons/react/24/outline';
import PaperClipIcon from '../../icons/PaperClipIcon';
import PuzzleIcon from '../../icons/PuzzleIcon';
import XMarkIcon from '../../icons/XMarkIcon';

const ResourceMentionView: React.FC<NodeViewProps> = ({ node, deleteNode }) => {
  const attrs = node.attrs as {
    kind: 'attachment' | 'skill';
    label: string;
    dataUrl?: string;
    isImage?: boolean;
    isOfficial?: boolean;
  };
  const isSkill = attrs.kind === 'skill';

  return (
    <NodeViewWrapper
      as="span"
      className={`mx-1 inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs align-middle ${
        isSkill
          ? 'border-claude-accent/30 bg-claude-accent/10 text-claude-accent'
          : 'dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text'
      }`}
      data-drag-handle
    >
      {isSkill ? (
        <PuzzleIcon className="h-3.5 w-3.5 flex-shrink-0" />
      ) : attrs.isImage && attrs.dataUrl ? (
        <span className="flex h-5 w-6 flex-shrink-0 items-center justify-center overflow-hidden rounded-md border dark:border-claude-darkBorder/60 border-claude-border/60 bg-black/5 dark:bg-white/5">
          <img src={attrs.dataUrl} alt={attrs.label} className="h-full w-full object-contain" />
        </span>
      ) : attrs.isImage ? (
        <PhotoIcon className="h-3.5 w-3.5 flex-shrink-0 text-blue-500" />
      ) : (
        <PaperClipIcon className="h-3.5 w-3.5 flex-shrink-0" />
      )}
      <span className="max-w-[180px] truncate">{attrs.label}</span>
      {attrs.isOfficial && (
        <span className="rounded-full bg-claude-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-claude-accent">
          OFFICIAL
        </span>
      )}
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          deleteNode();
        }}
        className="rounded-full p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
      >
        <XMarkIcon className="h-3 w-3" />
      </button>
    </NodeViewWrapper>
  );
};

export default ResourceMentionView;
