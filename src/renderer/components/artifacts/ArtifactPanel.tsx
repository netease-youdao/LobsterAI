import React, { useCallback, useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';
import {
  closePanel,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  selectActiveTab,
  selectArtifact,
  selectPanelWidth,
  selectSelectedArtifact,
  setActiveTab,
  setPanelWidth,
} from '@/store/slices/artifactSlice';
import type { ArtifactType } from '@/types/artifact';
import type { Artifact } from '@/types/artifact';

import ArtifactRenderer from './ArtifactRenderer';
import FileDirectoryView from './FileDirectoryView';
import CodeRenderer from './renderers/CodeRenderer';

const t = (key: string) => i18nService.t(key);

const BROWSER_OPENABLE_TYPES = new Set<ArtifactType>(['html', 'svg', 'mermaid', 'react']);

function buildBrowserHtml(artifact: Artifact): string | null {
  switch (artifact.type) {
    case 'html':
      return artifact.content;
    case 'svg':
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${artifact.title}</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5}</style></head><body>${artifact.content}</body></html>`;
    case 'mermaid':
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${artifact.title}</title><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff;font-family:system-ui,sans-serif}</style></head><body><pre class="mermaid">${escapeHtml(artifact.content)}</pre><script>mermaid.initialize({startOnLoad:true,theme:'default',securityLevel:'loose'});<\/script></body></html>`;
    case 'react':
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${artifact.title}</title><script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"><\/script><script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"><\/script><script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js"><\/script><script src="https://cdn.tailwindcss.com"><\/script><style>body{margin:0;font-family:system-ui,sans-serif}#root{min-height:100vh}.react-render-error{color:#ef4444;padding:16px;font-family:monospace;white-space:pre-wrap}</style><script>var useState=React.useState;var useEffect=React.useEffect;var useRef=React.useRef;var useMemo=React.useMemo;var useCallback=React.useCallback;var useContext=React.useContext;var useReducer=React.useReducer;var Fragment=React.Fragment;var createElement=React.createElement;var forwardRef=React.forwardRef;var memo=React.memo;var createContext=React.createContext;<\/script></head><body><div id="root"></div><script type="text/babel">try{${artifact.content.replace(/import\s+.*?['"][^'"]+['"]\s*;?\s*/g, '').replace(/export\s+default\s+function\s+/, 'function ').replace(/export\s+default\s+class\s+/, 'class ').replace(/export\s+default\s+(\w+)\s*;?/, '').replace(/export\s+(?=(?:const|let|var|function|class)\s)/g, '')}; var __C__=typeof App!=='undefined'?App:null; if(__C__)ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(__C__));else document.getElementById('root').innerHTML='<div class=\"react-render-error\">Component not found</div>';}catch(e){document.getElementById('root').innerHTML='<div class=\"react-render-error\">'+e.message+'</div>';}<\/script></body></html>`;
    default:
      return null;
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TYPE_LABELS: Record<ArtifactType, string> = {
  html: 'Html',
  svg: 'Svg',
  image: 'Image',
  mermaid: 'Mermaid',
  react: 'React',
  code: 'Code',
};

const TYPE_ICONS: Record<ArtifactType, string> = {
  html: '<>',
  svg: '🎨',
  image: '🖼',
  mermaid: '📊',
  react: '⚛',
  code: '<>',
};

interface ArtifactPanelProps {
  artifacts: Artifact[];
}

const ArtifactPanel: React.FC<ArtifactPanelProps> = ({ artifacts }) => {
  const dispatch = useDispatch();
  const selectedArtifact = useSelector(selectSelectedArtifact);
  const panelWidth = useSelector(selectPanelWidth);
  const activeTab = useSelector(selectActiveTab);
  const selectedArtifactId = useSelector((state: RootState) => state.artifact.selectedArtifactId);

  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    startX.current = e.clientX;
    startWidth.current = panelWidth;
    document.body.classList.add('select-none');

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = startX.current - moveEvent.clientX;
      const maxAvailable = Math.max(MIN_PANEL_WIDTH, window.innerWidth - 480 - 4);
      const clampedMax = Math.min(MAX_PANEL_WIDTH, maxAvailable);
      const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(clampedMax, startWidth.current + delta));
      dispatch(setPanelWidth(newWidth));
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.body.classList.remove('select-none');
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [panelWidth, dispatch]);

  useEffect(() => {
    return () => {
      document.body.classList.remove('select-none');
    };
  }, []);

  const handleClose = useCallback(() => dispatch(closePanel()), [dispatch]);
  const handleSelectArtifact = useCallback((id: string) => dispatch(selectArtifact(id)), [dispatch]);

  const handleCopy = useCallback(async () => {
    if (selectedArtifact) {
      await navigator.clipboard.writeText(selectedArtifact.content);
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: t('messageCopied') }));
    }
  }, [selectedArtifact]);

  const handleRevealInFolder = useCallback(() => {
    if (!selectedArtifact?.filePath) return;
    window.electron?.shell?.showItemInFolder(selectedArtifact.filePath);
  }, [selectedArtifact]);

  const handleOpenInBrowser = useCallback(() => {
    if (!selectedArtifact) return;

    // Has file on disk: open directly
    if (selectedArtifact.filePath) {
      const fileUrl = `file://${selectedArtifact.filePath}`;
      window.electron?.shell?.openExternal(fileUrl);
      return;
    }

    // No file path: generate HTML and open via temp file
    if (!selectedArtifact.content) return;
    const html = buildBrowserHtml(selectedArtifact);
    if (html) {
      window.electron?.shell?.openHtmlInBrowser(html);
    }
  }, [selectedArtifact]);

  return (
    <>
      {/* Drag handle */}
      <div
        className="w-1 shrink-0 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
        onMouseDown={handleResizeStart}
      />
      <aside
        style={{ width: panelWidth, maxWidth: 'calc(100vw - 480px - 4px)' }}
        className="shrink border-l border-border bg-background flex h-full overflow-hidden"
      >
        {/* Left: File list */}
        <div className={`${selectedArtifact ? 'w-[180px] shrink-0 border-r border-border' : 'flex-1'} flex flex-col h-full overflow-hidden`}>
          <div className="h-10 flex items-center px-3 border-b border-border shrink-0">
            <span className="text-xs font-medium text-secondary">{t('artifactFiles')}</span>
            <span className="flex-1" />
            <button
              onClick={handleClose}
              className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface transition-colors"
            >
              <CloseIcon />
            </button>
          </div>
          <FileDirectoryView
            artifacts={artifacts}
            selectedId={selectedArtifactId}
            onSelect={handleSelectArtifact}
          />
        </div>

        {/* Right: Preview area (only shown when an artifact is selected) */}
        {selectedArtifact && (
          <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
            {/* Header: filename + type + actions */}
            <div className="h-10 flex items-center gap-2 px-3 border-b border-border shrink-0">
              <span className="text-xs text-muted">{TYPE_ICONS[selectedArtifact.type] || '<>'}</span>
              <span className="text-sm font-medium truncate">{selectedArtifact.fileName || selectedArtifact.title}</span>
              <span className="text-xs text-muted">{TYPE_LABELS[selectedArtifact.type] || selectedArtifact.type}</span>
              <span className="flex-1" />
              <button
                onClick={handleCopy}
                className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface transition-colors"
                title={t('artifactCopyCode')}
              >
                <CopyIcon />
              </button>
              {BROWSER_OPENABLE_TYPES.has(selectedArtifact.type) && (
                <button
                  onClick={handleOpenInBrowser}
                  className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface transition-colors"
                  title={t('artifactOpenInBrowser')}
                >
                  <BrowserIcon />
                </button>
              )}
              {selectedArtifact.filePath && (
                <button
                  onClick={handleRevealInFolder}
                  className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface transition-colors"
                  title={t('artifactOpenFolder')}
                >
                  <FolderIcon />
                </button>
              )}
              <button
                onClick={() => dispatch(selectArtifact(null))}
                className="p-1 rounded text-secondary hover:text-foreground hover:bg-surface transition-colors"
              >
                <CloseIcon />
              </button>
            </div>

            {/* Preview/Code tabs */}
            <div className="flex border-b border-border shrink-0">
              <button
                onClick={() => dispatch(setActiveTab('preview'))}
                className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
                  activeTab === 'preview'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-secondary hover:text-foreground'
                }`}
              >
                {t('artifactPreview')}
              </button>
              <button
                onClick={() => dispatch(setActiveTab('code'))}
                className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
                  activeTab === 'code'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-secondary hover:text-foreground'
                }`}
              >
                {t('artifactCode')}
              </button>
            </div>

            {/* Render area */}
            <div className="flex-1 min-h-0 overflow-hidden">
              {activeTab === 'preview' ? (
                <ArtifactRenderer artifact={selectedArtifact} sessionArtifacts={artifacts} />
              ) : (
                <CodeRenderer artifact={selectedArtifact} />
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
};

const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.5a1.5 1.5 0 00-1.5-1.5H3.5A1.5 1.5 0 002 3.5V9a1.5 1.5 0 001.5 1.5h2" />
  </svg>
);

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 4.5A1.5 1.5 0 013.5 3h2.879a1.5 1.5 0 011.06.44l.622.62a1.5 1.5 0 001.06.44H12.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" />
  </svg>
);

const BrowserIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="6" />
    <ellipse cx="8" cy="8" rx="2.5" ry="6" />
    <path d="M2 8h12" />
  </svg>
);

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export default ArtifactPanel;
