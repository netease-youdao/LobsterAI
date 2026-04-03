import React, { useEffect, useState, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { i18nService } from '../../services/i18n';

interface SubTaskMessage {
  role: string;
  content: string;
}

interface SubTaskDetailDrawerProps {
  agentId: string;
  parentSessionId: string;
  onClose: () => void;
}

/** Module-level cache so re-opening a drawer doesn't flash "loading" */
const messageCache = new Map<string, SubTaskMessage[]>();

const SubTaskDetailDrawer: React.FC<SubTaskDetailDrawerProps> = ({
  agentId,
  parentSessionId,
  onClose,
}) => {
  const cacheKey = `${parentSessionId}:${agentId}`;
  const cached = messageCache.get(cacheKey);

  const [messages, setMessages] = useState<SubTaskMessage[]>(cached ?? []);
  // Only show loading spinner if there's nothing cached to display
  const [loading, setLoading] = useState(!cached || cached.length === 0);
  const [error, setError] = useState<string | null>(null);

  const isFirstLoad = React.useRef(!cached || cached.length === 0);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(messages.length);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
    prevMessageCountRef.current = messages.length;
  }, [messages]);

  const fetchHistory = useCallback(async () => {
    // Only show loading spinner on first load when there's no cache
    if (isFirstLoad.current && messages.length === 0) {
      setLoading(true);
    }
    try {
      const result = await window.electron.cowork.getSubTaskHistory({
        parentSessionId,
        agentId,
      });
      if (result.success && result.messages) {
        setMessages(result.messages);
        messageCache.set(cacheKey, result.messages);
        setError(null);
      } else if (isFirstLoad.current && messages.length === 0) {
        setError(result.error || i18nService.t('subTaskNoHistory') || '暂无对话记录');
      }
    } catch (err) {
      if (isFirstLoad.current && messages.length === 0) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    } finally {
      setLoading(false);
      isFirstLoad.current = false;
    }
  }, [parentSessionId, agentId, cacheKey, messages.length]);

  useEffect(() => {
    fetchHistory();
    // Auto-refresh every 5 seconds while the drawer is open
    const timer = setInterval(fetchHistory, 5000);
    return () => clearInterval(timer);
  }, [fetchHistory]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const roleLabel = (role: string) => {
    if (role === 'user') return '📋 ' + (i18nService.t('subTaskRoleUser') || '任务指令');
    if (role === 'assistant') return '🤖 ' + agentId;
    if (role === 'tool') return '🔧 ' + (i18nService.t('subTaskRoleTool') || '工具调用');
    return role;
  };

  const roleBg = (role: string) =>
    role === 'assistant'
      ? 'bg-blue-50/60 dark:bg-blue-950/20'
      : role === 'tool'
        ? 'bg-amber-50/60 dark:bg-amber-950/20'
        : 'bg-gray-50/60 dark:bg-gray-800/20';

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      {/* Backdrop */}
      <div className="flex-1 bg-black/30" />

      {/* Drawer */}
      <div
        className="w-[480px] max-w-[90vw] h-full flex flex-col dark:bg-claude-darkBg bg-claude-bg shadow-2xl animate-slide-in-right"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm">🔍</span>
            <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text truncate">
              {i18nService.t('subTaskDetail') || '子任务详情'} — {agentId}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div ref={contentRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-claude-accent border-t-transparent rounded-full animate-spin" />
              <span className="ml-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('loading') || '加载中...'}
              </span>
            </div>
          )}

          {error && !loading && (
            <div className="text-center py-8">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {error}
              </p>
              <button
                onClick={fetchHistory}
                className="mt-3 px-3 py-1.5 text-xs rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors"
              >
                {i18nService.t('retry') || '重试'}
              </button>
            </div>
          )}

          {!loading && !error && messages.length === 0 && (
            <div className="text-center py-8">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('subTaskNoHistory') || '暂无对话记录'}
              </p>
            </div>
          )}

          {!loading && !error && messages.map((msg, idx) => {
            const trimmed = msg.content.trimEnd();
            const endsWithColon = trimmed.endsWith('：') || trimmed.endsWith(':');
            const isLast = idx === messages.length - 1;
            const showToolStatus = endsWithColon && msg.role === 'assistant';

            return (
              <div key={idx} className={`rounded-lg px-3 py-2.5 ${roleBg(msg.role)}`}>
                <div className="text-[10px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary uppercase tracking-wider mb-1.5">
                  {roleLabel(msg.role)}
                </div>
                <div className="text-sm dark:text-claude-darkText text-claude-text prose prose-sm dark:prose-invert max-w-none break-words">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                  {showToolStatus && (
                    <span className={`inline-flex items-center gap-1 mt-1 text-xs font-medium ${
                      isLast
                        ? 'text-blue-500 dark:text-blue-400'
                        : 'text-green-600 dark:text-green-400'
                    }`}>
                      {isLast ? (
                        <><span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" /> {i18nService.t('subTaskToolProcessing') || '处理中...'}</>
                      ) : (
                        <>✅ {i18nService.t('subTaskToolDone') || '已完成'}</>
                      )}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t dark:border-claude-darkBorder border-claude-border">
          <div className="flex items-center justify-between">
            <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {messages.length > 0
                ? `${messages.length} ${i18nService.t('subTaskMessages') || '条消息'}`
                : ''}
            </span>
            <button
              onClick={fetchHistory}
              className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent transition-colors"
              title={i18nService.t('refresh') || '刷新'}
            >
              🔄
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SubTaskDetailDrawer;

