import React, { useState, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { XMarkIcon, ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline';
import {
  selectActiveArtifact,
  selectArtifactPanelWidth,
  clearActiveArtifact,
} from '../../store/slices/artifactSlice';
import { i18nService } from '../../services/i18n';
import HtmlArtifactRenderer from './HtmlArtifactRenderer';
import CodeArtifactRenderer from './CodeArtifactRenderer';
import ReactArtifactRenderer from './ReactArtifactRenderer';

const TYPE_ICONS: Record<string, string> = {
  html: '🌐',
  svg: '🖼',
  mermaid: '📊',
  react: '⚛',
  code: '📝',
};

interface ArtifactPanelProps {
  layout?: 'split' | 'overlay';
  width?: number;
}

const ArtifactPanel: React.FC<ArtifactPanelProps> = ({
  layout = 'split',
  width,
}) => {
  const activeArtifact = useSelector(selectActiveArtifact);
  const panelWidth = useSelector(selectArtifactPanelWidth);
  const dispatch = useDispatch();
  const [isCopied, setIsCopied] = useState(false);

  const handleClose = useCallback(() => {
    dispatch(clearActiveArtifact());
  }, [dispatch]);

  const handleCopySource = useCallback(async () => {
    if (!activeArtifact) return;
    try {
      await navigator.clipboard.writeText(activeArtifact.content);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1500);
    } catch (error) {
      console.error('Failed to copy artifact source:', error);
    }
  }, [activeArtifact]);

  if (!activeArtifact) return null;

  const renderBody = () => {
    switch (activeArtifact.type) {
      case 'html':
        return (
          <HtmlArtifactRenderer
            content={activeArtifact.content}
            title={activeArtifact.title}
          />
        );
      case 'react':
        return (
          <ReactArtifactRenderer
            content={activeArtifact.content}
            title={activeArtifact.title}
          />
        );
      case 'svg':
      case 'mermaid':
      case 'code':
        return (
          <CodeArtifactRenderer
            content={activeArtifact.content}
            language={activeArtifact.language || activeArtifact.type}
            title={activeArtifact.title}
          />
        );
      default:
        return (
          <CodeArtifactRenderer
            content={activeArtifact.content}
            language={activeArtifact.language}
            title={activeArtifact.title}
          />
        );
    }
  };

  return (
    <div
      className={`h-full flex flex-col dark:bg-claude-darkBg bg-white overflow-hidden ${
        layout === 'overlay'
          ? 'absolute inset-y-0 right-0 z-20 border dark:border-claude-darkBorder border-claude-border rounded-l-2xl shadow-2xl'
          : 'border-l dark:border-claude-darkBorder border-claude-border flex-shrink-0'
      }`}
      style={{ width: width ?? panelWidth }}
    >
      {/* Panel Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b dark:border-claude-darkBorder border-claude-border
        dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
        <div className="flex items-center gap-2 min-w-0">
          <span>{TYPE_ICONS[activeArtifact.type] || '📄'}</span>
          <span className="text-sm dark:text-claude-darkText text-claude-text truncate">
            {activeArtifact.title}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={handleCopySource}
            className="p-1.5 rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
            title={i18nService.t('artifactCopySource')}
          >
            {isCopied ? (
              <CheckIcon className="h-4 w-4 text-green-500" />
            ) : (
              <ClipboardDocumentIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            )}
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
            title={i18nService.t('artifactClose')}
          >
            <XMarkIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          </button>
        </div>
      </div>

      {/* Panel Body */}
      <div className="flex-1 overflow-auto">
        {renderBody()}
      </div>
    </div>
  );
};

export default ArtifactPanel;
