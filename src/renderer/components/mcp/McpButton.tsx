import React, { useRef, useState } from 'react';
import ConnectorIcon from '../icons/ConnectorIcon';
import McpPopover from './McpPopover';

interface McpButtonProps {
  onManageMcp: () => void;
  sessionId?: string;
  className?: string;
}

const McpButton: React.FC<McpButtonProps> = ({
  onManageMcp,
  sessionId,
  className = '',
}) => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleButtonClick = () => {
    setIsPopoverOpen(prev => !prev);
  };

  const handleClosePopover = () => {
    setIsPopoverOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleButtonClick}
        className={`p-2 rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent dark:hover:text-claude-accent hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors ${className}`}
        title="MCP"
      >
        <ConnectorIcon className="h-5 w-5" />
      </button>
      <McpPopover
        isOpen={isPopoverOpen}
        onClose={handleClosePopover}
        onManageMcp={onManageMcp}
        anchorRef={buttonRef}
        sessionId={sessionId}
      />
    </div>
  );
};

export default McpButton;
