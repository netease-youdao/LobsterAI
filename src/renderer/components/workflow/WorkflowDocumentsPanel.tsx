import React, { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { DocumentIcon, ArrowTopRightOnSquareIcon, ClockIcon, DocumentTextIcon } from '@heroicons/react/24/outline';

interface DocumentInfo {
  name: string;
  path: string;
  size: number;
  modifiedTime: number;
  agentType: 'technical-writer' | 'developer' | 'qa' | 'unknown';
}

interface WorkflowDocumentsPanelProps {
  workingDirectory: string;
  onClose: () => void;
  isRunning?: boolean;
}

// Agent type to label and color mapping
const AGENT_CONFIG = {
  'technical-writer': {
    label: 'Technical Writer',
    color: '#3B82F6', // Blue
  },
  'developer': {
    label: 'Developer',
    color: '#10B981', // Green
  },
  'qa': {
    label: 'QA Engineer',
    color: '#EF4444', // Red
  },
  'unknown': {
    label: 'Unknown',
    color: '#6B7280', // Gray
  },
};

const WorkflowDocumentsPanel: React.FC<WorkflowDocumentsPanelProps> = ({
  workingDirectory,
  onClose,
  isRunning,
}) => {
  const [files, setFiles] = useState<DocumentInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<DocumentInfo | null>(null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch document list
  const fetchDocuments = useCallback(async () => {
    if (!workingDirectory) return;

    try {
      const result = await window.electron.workflow.listDocuments(workingDirectory);
      if (result.success && result.files) {
        setFiles(result.files);
        setError(null);
      } else {
        setError(result.error || 'Failed to load documents');
      }
    } catch (err) {
      setError('Failed to load documents');
      console.error('[WorkflowDocumentsPanel] Error fetching documents:', err);
    }
  }, [workingDirectory]);

  // Fetch document content
  const fetchContent = useCallback(async (file: DocumentInfo) => {
    if (!file) return;

    setLoading(true);
    try {
      const result = await window.electron.workflow.readDocument(file.path, workingDirectory);
      if (result.success) {
        setContent(result.content || '');
        setError(null);
      } else {
        setError(result.error || 'Failed to load document content');
      }
    } catch (err) {
      setError('Failed to load document content');
      console.error('[WorkflowDocumentsPanel] Error fetching content:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch and auto-refresh
  useEffect(() => {
    fetchDocuments();

    // Auto-refresh every 5 seconds when workflow is running
    const interval = setInterval(() => {
      if (isRunning) {
        fetchDocuments();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchDocuments, isRunning]);

  // Fetch content when file is selected
  useEffect(() => {
    if (selectedFile) {
      fetchContent(selectedFile);
    }
  }, [selectedFile, fetchContent]);

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Format timestamp
  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  // Open file in editor
  const handleOpenInEditor = () => {
    if (selectedFile) {
      // Use shell to open in default editor
      window.electron.shell.openPath(selectedFile.path);
    }
  };

  return (
    <div className="absolute right-0 top-0 h-full w-[800px] z-50 bg-claude-surface dark:bg-claude-darkSurface border-l dark:border-claude-darkBorder border-claude-border shadow-2xl flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b dark:border-claude-darkBorder border-claude-border">
        <div className="flex items-center gap-2">
          <DocumentTextIcon className="w-5 h-5 text-claude-text dark:text-claude-darkText" />
          <h2 className="text-lg font-semibold text-claude-text dark:text-claude-darkText">
            Documents
          </h2>
        </div>
        <button
          onClick={onClose}
          className="p-1 px-[10px] py-[6px] text-xs font-semibold rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#252528] text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-[#303033] hover:text-gray-900 dark:hover:text-white transition-all transform active:scale-95"
        >
          ESC
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: File List */}
        <div className="w-64 border-r dark:border-claude-darkBorder border-claude-border flex flex-col bg-claude-bg dark:bg-claude-darkBg">
          {files.length === 0 ? (
            <div className="flex-1 flex items-center justify-center p-4">
              <div className="text-center text-claude-textSecondary dark:text-claude-darkTextSecondary">
                <DocumentIcon className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p className="text-sm">暂无文档</p>
                <p className="text-xs mt-1 opacity-75">
                  运行工作流后，Agent 生成的文档将在此处显示
                </p>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {files.map((file) => {
                const config = AGENT_CONFIG[file.agentType];
                return (
                  <button
                    key={file.path}
                    onClick={() => setSelectedFile(file)}
                    className={`w-full p-3 text-left border-b dark:border-claude-darkBorder border-claude-border hover:bg-claude-surface dark:hover:bg-claude-darkSurface transition-colors ${
                      selectedFile?.path === file.path
                        ? 'bg-claude-surface dark:bg-claude-darkSurface'
                        : ''
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <DocumentIcon className="w-4 h-4 text-claude-textSecondary dark:text-claude-darkTextSecondary shrink-0" />
                      <span className="text-sm font-medium text-claude-text dark:text-claude-darkText truncate">
                        {file.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className="text-xs px-1.5 py-0.5 rounded text-white"
                        style={{ backgroundColor: config.color }}
                      >
                        {config.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      <span>{formatSize(file.size)}</span>
                      <span className="flex items-center gap-0.5">
                        <ClockIcon className="w-3 h-3" />
                        {formatTime(file.modifiedTime)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Document Preview */}
        <div className="flex-1 flex flex-col overflow-hidden bg-claude-surface dark:bg-claude-darkSurface">
          {selectedFile ? (
            <>
              {/* Preview Header */}
              <div className="flex items-center justify-between p-3 border-b dark:border-claude-darkBorder border-claude-border bg-claude-bg dark:bg-claude-darkBg">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-claude-text dark:text-claude-darkText truncate">
                    {selectedFile.name}
                  </p>
                  <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary truncate">
                    {selectedFile.path}
                  </p>
                </div>
                <button
                  onClick={handleOpenInEditor}
                  className="ml-2 p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  title="在编辑器中打开"
                >
                  <ArrowTopRightOnSquareIcon className="w-4 h-4 text-claude-textSecondary dark:text-claude-darkTextSecondary" />
                </button>
              </div>

              {/* Preview Content */}
              <div className="flex-1 overflow-y-auto p-4">
                {loading ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      加载中...
                    </div>
                  </div>
                ) : (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown
                      components={{
                        code({ className, children, ...props }) {
                          const match = /language-(\w+)/.exec(className || '');
                          const isInline = !match;
                          return isInline ? (
                            <code className={className} {...props}>
                              {children}
                            </code>
                          ) : (
                            <SyntaxHighlighter
                              style={oneDark}
                              language={match[1]}
                              PreTag="div"
                            >
                              {String(children).replace(/\n$/, '')}
                            </SyntaxHighlighter>
                          );
                        },
                      }}
                    >
                      {content}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-claude-textSecondary dark:text-claude-darkTextSecondary">
                <DocumentTextIcon className="w-16 h-16 mx-auto mb-2 opacity-30" />
                <p>选择一个文件查看预览</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Error Toast */}
      {error && (
        <div className="absolute bottom-4 left-4 right-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}
    </div>
  );
};

export default WorkflowDocumentsPanel;
