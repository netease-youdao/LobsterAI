import React, { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
  ChevronUpIcon,
  ChevronDownIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  ArrowPathIcon,
  DocumentIcon,
  FolderIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/outline';
import { workflowEngine, type WorkflowLogEntry } from '../../services/workflowEngine';
import { i18nService } from '../../services/i18n';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';

interface WorkflowOutputPanelProps {
  workingDirectory: string;
  isRunning: boolean;
}

interface FileInfo {
  name: string;
  path: string;
  size: number;
  modifiedTime: number;
  agentName: string;
}

type TabType = 'log' | 'files';

const WorkflowOutputPanel: React.FC<WorkflowOutputPanelProps> = ({
  workingDirectory,
  isRunning,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('log');
  const [logs, setLogs] = useState<WorkflowLogEntry[]>(() => workflowEngine.getState().logs);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [panelHeight, setPanelHeight] = useState(240);
  const [isDragging, setIsDragging] = useState(false);
  const [isCopying, setIsCopying] = useState(false);
  const projectWorkingDirectory = useSelector((state: RootState) => state.cowork.config.workingDirectory);

  // Subscribe to workflow engine logs & sync existing logs on mount
  useEffect(() => {
    // Sync any existing logs from engine (in case component remounted mid-run)
    const existingLogs = workflowEngine.getState().logs;
    if (existingLogs.length > 0) {
      setLogs([...existingLogs]);
    }
    workflowEngine.setLogCallback((newLogs) => {
      setLogs([...newLogs]);
    });
  }, []);

  // Fetch files when panel is expanded and Files tab is active
  const fetchFiles = useCallback(async () => {
    if (!workingDirectory) return;

    try {
      const result = await window.electron.workflow.listDocuments(workingDirectory);
      if (result.success && result.files) {
        // Group files by parent directory name, or use "Root" for files in workingDirectory
        const mappedFiles: FileInfo[] = result.files.map(f => {
          // Get parent directory name from path
          const pathParts = f.path.replace(/\\/g, '/').split('/');
          const parentDir = pathParts.length > 1 ? pathParts[pathParts.length - 2] : 'Root';
          return {
            name: f.name,
            path: f.path,
            size: f.size,
            modifiedTime: f.modifiedTime,
            agentName: parentDir,
          };
        });
        setFiles(mappedFiles);
      }
    } catch (err) {
      console.error('[WorkflowOutputPanel] Error fetching files:', err);
    }
  }, [workingDirectory]);

  // Fetch file content
  const fetchFileContent = useCallback(async (file: FileInfo) => {
    if (!file || !workingDirectory) return;

    setLoadingContent(true);
    try {
      const result = await window.electron.workflow.readDocument(file.path, workingDirectory);
      if (result.success) {
        setFileContent(result.content || '');
      }
    } catch (err) {
      console.error('[WorkflowOutputPanel] Error fetching content:', err);
    } finally {
      setLoadingContent(false);
    }
  }, [workingDirectory]);

  // Initial fetch and auto-refresh
  useEffect(() => {
    if (!collapsed && activeTab === 'files') {
      fetchFiles();
    }
  }, [collapsed, activeTab, fetchFiles]);

  // Auto-refresh files when running OR when workingDirectory changes
  useEffect(() => {
    if (!collapsed && activeTab === 'files' && workingDirectory) {
      fetchFiles();
    }
  }, [workingDirectory]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh files when running
  useEffect(() => {
    if (isRunning && !collapsed && activeTab === 'files') {
      const interval = setInterval(fetchFiles, 3000);
      return () => clearInterval(interval);
    }
  }, [isRunning, collapsed, activeTab, fetchFiles]);

  // Fetch files when workflow completes
  useEffect(() => {
    if (!isRunning && workingDirectory) {
      fetchFiles();
    }
  }, [isRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch content when file is selected
  useEffect(() => {
    if (selectedFile) {
      fetchFileContent(selectedFile);
    }
  }, [selectedFile, fetchFileContent]);

  // Auto-expand when workflow starts
  useEffect(() => {
    if (isRunning) {
      setCollapsed(false);
      setActiveTab('log');
    }
  }, [isRunning]);

  // Group files by agent name
  const filesByAgent = files.reduce((acc, file) => {
    if (!acc[file.agentName]) {
      acc[file.agentName] = [];
    }
    acc[file.agentName].push(file);
    return acc;
  }, {} as Record<string, FileInfo[]>);

  // Handle drag to resize
  const handleMouseDown = () => {
    setIsDragging(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const newHeight = window.innerHeight - e.clientY;
        setPanelHeight(Math.max(120, Math.min(window.innerHeight * 0.5, newHeight)));
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Format duration
  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Format time
  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  };

  // Get status color
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return 'text-yellow-500';
      case 'completed': return 'text-green-500';
      case 'error': return 'text-red-500';
      default: return 'text-gray-400';
    }
  };

  // Get status icon
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running':
        return <ClockIcon className="w-4 h-4 text-yellow-500 animate-pulse" />;
      case 'completed':
        return <CheckCircleIcon className="w-4 h-4 text-green-500" />;
      case 'error':
        return <XCircleIcon className="w-4 h-4 text-red-500" />;
      default:
        return <ClockIcon className="w-4 h-4 text-gray-400" />;
    }
  };

  return (
    <div
      className="flex flex-col border-t dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface"
      style={{ height: collapsed ? 40 : panelHeight }}
    >
      {/* Drag Handle */}
      <div
        className={`h-1 cursor-row-resize hover:bg-claude-accent transition-colors ${isDragging ? 'bg-claude-accent' : ''}`}
        onMouseDown={handleMouseDown}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-4 h-10 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        {/* Tabs */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab('log')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'log'
              ? 'bg-claude-accent text-white'
              : 'text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
              }`}
          >
            <span className="flex items-center gap-1.5">
              <ArrowPathIcon className="w-4 h-4" />
              {i18nService.t('workflowRunLog') || 'Run Log'}
            </span>
          </button>
          <button
            onClick={() => setActiveTab('files')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'files'
              ? 'bg-claude-accent text-white'
              : 'text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
              }`}
          >
            <span className="flex items-center gap-1.5">
              <FolderIcon className="w-4 h-4" />
              {i18nService.t('workflowOutputFiles') || 'Output Files'}
              {files.length > 0 && (
                <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-claude-accent/20">
                  {files.length}
                </span>
              )}
            </span>
          </button>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {isRunning && activeTab === 'log' && (
            <button
              onClick={() => workflowEngine.stop()}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium bg-red-500 hover:bg-red-600 text-white transition-colors"
            >
              <XCircleIcon className="w-3.5 h-3.5" />
              {i18nService.t('workflowStop') || 'Stop'}
            </button>
          )}
          {activeTab === 'files' && files.length > 0 && projectWorkingDirectory && (
            <button
              onClick={async () => {
                if (!workingDirectory || !projectWorkingDirectory) return;
                setIsCopying(true);
                try {
                  const result = await window.electron.workflow.copyToProject(workingDirectory, projectWorkingDirectory);
                  if (result.success) {
                    window.dispatchEvent(new CustomEvent('app:showToast', {
                      detail: `✅ ${result.copiedCount} files copied to project`,
                    }));
                  } else {
                    window.dispatchEvent(new CustomEvent('app:showToast', {
                      detail: `❌ Copy failed: ${result.error}`,
                    }));
                  }
                } catch (err) {
                  console.error('[WorkflowOutputPanel] Copy to project error:', err);
                } finally {
                  setIsCopying(false);
                }
              }}
              disabled={isCopying}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium bg-green-600 hover:bg-green-700 text-white transition-colors disabled:opacity-50"
            >
              <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
              {isCopying ? 'Copying...' : (i18nService.t('workflowCopyToProject') || 'Copy to Project')}
            </button>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-1 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            {collapsed ? (
              <ChevronUpIcon className="w-4 h-4 text-claude-textSecondary dark:text-claude-darkTextSecondary" />
            ) : (
              <ChevronDownIcon className="w-4 h-4 text-claude-textSecondary dark:text-claude-darkTextSecondary" />
            )}
          </button>
        </div>
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="flex-1 flex overflow-hidden">
          {/* Log Tab */}
          {activeTab === 'log' && (
            <div className="flex-1 overflow-y-auto px-4 py-2">
              {logs.length === 0 ? (
                <div className="flex items-center justify-center h-full text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  <p className="text-sm">
                    {isRunning
                      ? i18nService.t('workflowLogWaiting') || 'Waiting for workflow to start...'
                      : i18nService.t('workflowLogEmpty') || 'No logs yet. Run a workflow to see execution logs.'
                    }
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  {logs.map((log) => (
                    <div
                      key={log.id}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm bg-claude-bg dark:bg-claude-darkBg ${log.status === 'running' ? 'ring-1 ring-yellow-500/30' : ''
                        }`}
                    >
                      {getStatusIcon(log.status)}
                      <span className="flex-1 font-medium text-claude-text dark:text-claude-darkText truncate">
                        {log.agentName}
                        {log.iteration !== undefined && (
                          <span className="ml-1 text-gray-400">#{log.iteration + 1}</span>
                        )}
                      </span>
                      <span className={`text-xs ${getStatusColor(log.status)}`}>
                        {log.status === 'running'
                          ? i18nService.t('workflowLogRunning') || 'Running...'
                          : log.status === 'completed'
                            ? i18nService.t('workflowLogCompleted') || 'Completed'
                            : log.status === 'error'
                              ? i18nService.t('workflowLogError') || 'Error'
                              : ''
                        }
                      </span>
                      {log.duration && (
                        <span className="text-xs text-gray-400">
                          {formatDuration(log.duration)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Files Tab */}
          {activeTab === 'files' && (
            <div className="flex-1 flex overflow-hidden">
              {/* File List */}
              <div className="w-56 border-r dark:border-claude-darkBorder border-claude-border overflow-y-auto">
                {files.length === 0 ? (
                  <div className="flex items-center justify-center h-full p-4 text-center text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    <div>
                      <FolderIcon className="w-10 h-10 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">
                        {i18nService.t('workflowNoFiles') || 'No output files yet'}
                      </p>
                      <p className="text-xs mt-1 opacity-75">
                        {i18nService.t('workflowNoFilesHint') || 'Files generated by agents will appear here'}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="p-2">
                    {Object.entries(filesByAgent).map(([agentName, agentFiles]) => (
                      <div key={agentName} className="mb-3">
                        <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold text-claude-textSecondary dark:text-claude-darkTextSecondary uppercase">
                          <FolderIcon className="w-3.5 h-3.5" />
                          {agentName}
                        </div>
                        {agentFiles.map((file) => (
                          <button
                            key={file.path}
                            onClick={() => setSelectedFile(file)}
                            className={`w-full text-left px-2 py-1.5 rounded-lg text-sm hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors ${selectedFile?.path === file.path
                              ? 'bg-claude-surface dark:bg-claude-darkSurface'
                              : ''
                              }`}
                          >
                            <div className="flex items-center gap-1.5">
                              <DocumentIcon className="w-4 h-4 text-claude-textSecondary dark:text-claude-darkTextSecondary shrink-0" />
                              <span className="truncate text-claude-text dark:text-claude-darkText">
                                {file.name}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-400 ml-5">
                              <span>{formatSize(file.size)}</span>
                              <span>{formatTime(file.modifiedTime)}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* File Preview */}
              <div className="flex-1 flex flex-col overflow-hidden">
                {selectedFile ? (
                  <>
                    <div className="flex items-center justify-between px-3 py-2 border-b dark:border-claude-darkBorder border-claude-border bg-claude-bg dark:bg-claude-darkBg">
                      <span className="text-sm font-medium text-claude-text dark:text-claude-darkText truncate">
                        {selectedFile.name}
                      </span>
                      <button
                        onClick={() => window.electron.shell.openPath(selectedFile.path)}
                        className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                        title="Open in editor"
                      >
                        <ArrowTopRightOnSquareIcon className="w-4 h-4 text-claude-textSecondary dark:text-claude-darkTextSecondary" />
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-3">
                      {loadingContent ? (
                        <div className="flex items-center justify-center h-full text-claude-textSecondary dark:text-claude-darkTextSecondary">
                          Loading...
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
                            {fileContent}
                          </ReactMarkdown>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-center h-full text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    <div className="text-center">
                      <DocumentIcon className="w-12 h-12 mx-auto mb-2 opacity-30" />
                      <p>{i18nService.t('workflowSelectFile') || 'Select a file to preview'}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default WorkflowOutputPanel;
