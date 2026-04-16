import React, { useState, useEffect, useRef, useCallback } from 'react';
import WindowTitleBar from '../window/WindowTitleBar';

// ── Types ──────────────────────────────────────────────────────────────────

type ExtCommand = {
  action?: string;
  taskId?: string;
  electronTaskId?: string;
  title?: string;
  [key: string]: unknown;
};

type MessageEntry =
  | { kind: 'sent'; text: string; time: number; serverId?: string; error?: string; ext?: ExtCommand; isAutoReply?: boolean }
  | { kind: 'received'; from: string; text: string; serverId?: string; time: number; ext?: ExtCommand }
  | { kind: 'log'; text: string; time: number };

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function makeId(): string {
  return Math.random().toString(36).slice(2);
}

const ACTION_LABELS: Record<string, string> = {
  normal: '普通',
  create: '创建会话',
  update: '更新会话',
  pin: '置顶',
  unpin: '取消置顶',
  delete: '删除会话',
  ack: 'Ack',
};

// ── ExtBadge ───────────────────────────────────────────────────────────────

function ExtBadge({ ext }: { ext: ExtCommand }) {
  const [expanded, setExpanded] = useState(false);
  const action = ext.action ?? 'normal';
  const label = ACTION_LABELS[action] ?? action;
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-surface border border-border text-secondary hover:text-foreground transition-colors"
      >
        <span className="font-mono">{label}</span>
        {ext.taskId && <span className="opacity-60">· {String(ext.taskId).slice(-8)}</span>}
        <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {expanded && (
        <pre className="mt-1 text-[10px] text-secondary bg-surface border border-border rounded p-2 overflow-x-auto max-w-[280px]">
          {JSON.stringify(ext, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

interface IosCommViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

// Preset ext templates for quick send
const EXT_PRESETS: { label: string; ext: ExtCommand }[] = [
  { label: '普通消息', ext: { taskId: '' } },
  { label: '创建会话', ext: { action: 'create', taskId: '', title: '测试会话' } },
  { label: '置顶', ext: { action: 'pin', taskId: '' } },
  { label: '取消置顶', ext: { action: 'unpin', taskId: '' } },
  { label: '删除', ext: { action: 'delete', taskId: '' } },
];

const IosCommView: React.FC<IosCommViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [messages, setMessages] = useState<(MessageEntry & { id: string })[]>([]);
  const [inputText, setInputText] = useState('');
  const [extText, setExtText] = useState('');
  const [showExtInput, setShowExtInput] = useState(false);
  const [sending, setSending] = useState(false);
  const [extError, setExtError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const addEntry = useCallback((entry: MessageEntry) => {
    setMessages(prev => [...prev, { ...entry, id: makeId() }]);
  }, []);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Subscribe to IPC events
  useEffect(() => {
    const unsubSent = (window.electron as any).ydNim.onMessageSent(
      (msg: { text: string; time: number; serverId?: string; error?: string; ext?: ExtCommand; isAutoReply?: boolean }) => {
        addEntry({ kind: 'sent', ...msg });
      }
    );
    const unsubReceived = (window.electron as any).ydNim.onMessageReceived(
      (msg: { from: string; text: string; serverId?: string; time: number; ext?: ExtCommand }) => {
        addEntry({ kind: 'received', ...msg });
      }
    );
    const unsubLog = (window.electron as any).ydNim.onLog(
      (entry: { text: string; time: number }) => {
        addEntry({ kind: 'log', ...entry });
      }
    );
    return () => {
      unsubSent();
      unsubReceived();
      unsubLog();
    };
  }, [addEntry]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || sending) return;

    // Parse ext if shown
    let ext: object | undefined;
    if (showExtInput && extText.trim()) {
      try {
        ext = JSON.parse(extText.trim());
        setExtError(null);
      } catch {
        setExtError('JSON 格式错误');
        return;
      }
    }

    setSending(true);
    setInputText('');
    try {
      await (window.electron as any).ydNim.sendMessage(text, ext);
    } finally {
      setSending(false);
    }
  }, [inputText, extText, showExtInput, sending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const applyPreset = useCallback((preset: { label: string; ext: ExtCommand }) => {
    setExtText(JSON.stringify(preset.ext, null, 2));
    setShowExtInput(true);
    setExtError(null);
  }, []);

  return (
    <div className="flex-1 flex flex-col bg-background h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b border-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              {onToggleSidebar && (
                <button
                  type="button"
                  onClick={onToggleSidebar}
                  className="p-1 rounded hover:bg-surface-raised text-secondary hover:text-foreground transition-colors"
                  aria-label="展开侧栏"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M9 3v18" />
                  </svg>
                </button>
              )}
              {onNewChat && (
                <button
                  type="button"
                  onClick={onNewChat}
                  className="p-1 rounded hover:bg-surface-raised text-secondary hover:text-foreground transition-colors"
                  aria-label="新建任务"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              )}
              {updateBadge}
            </div>
          )}
          <h1 className="text-lg font-semibold text-foreground">iOS 通信调试</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMessages([])}
            className="text-xs text-secondary hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-surface-raised"
          >
            清空
          </button>
          <WindowTitleBar inline />
        </div>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2 min-h-0 [scrollbar-gutter:stable]">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-secondary select-none">
            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p className="text-sm">等待 NIM 登录后收发消息…</p>
          </div>
        )}
        {messages.map(entry => {
          if (entry.kind === 'log') {
            return (
              <div key={entry.id} className="flex justify-center">
                <span className="text-xs text-secondary bg-surface px-2 py-0.5 rounded-full">
                  {formatTime(entry.time)} · {entry.text}
                </span>
              </div>
            );
          }
          if (entry.kind === 'sent') {
            return (
              <div key={entry.id} className="flex flex-col items-end gap-0.5">
                <div className="flex items-center gap-1 mb-0.5">
                  {entry.isAutoReply && (
                    <span className="text-[10px] text-secondary bg-surface border border-border rounded px-1.5 py-0.5">
                      自动回复
                    </span>
                  )}
                </div>
                <div className="max-w-[75%] bg-primary text-white rounded-2xl rounded-br-sm px-3 py-2 text-sm break-all">
                  {entry.text}
                </div>
                {entry.ext && <div className="pr-1"><ExtBadge ext={entry.ext} /></div>}
                <div className="text-[11px] text-secondary pr-1">
                  {formatTime(entry.time)}
                  {entry.serverId && <span className="ml-1 opacity-70">✓ {entry.serverId.slice(-6)}</span>}
                  {entry.error && <span className="ml-1 text-red-400">✗ {entry.error}</span>}
                </div>
              </div>
            );
          }
          // received
          return (
            <div key={entry.id} className="flex flex-col items-start gap-0.5">
              <div className="text-[11px] text-secondary pl-1">{entry.from}</div>
              <div className="max-w-[75%] bg-surface-raised text-foreground rounded-2xl rounded-bl-sm px-3 py-2 text-sm break-all">
                {entry.text}
              </div>
              {entry.ext && <div className="pl-1"><ExtBadge ext={entry.ext} /></div>}
              <div className="text-[11px] text-secondary pl-1">
                {formatTime(entry.time)}
                {entry.serverId && <span className="ml-1 opacity-70">{entry.serverId.slice(-6)}</span>}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-border px-4 py-3 space-y-2">
        {/* Presets */}
        <div className="flex flex-wrap gap-1">
          {EXT_PRESETS.map(p => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p)}
              className="text-[11px] px-2 py-0.5 rounded border border-border text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowExtInput(v => !v)}
            className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${showExtInput ? 'border-primary text-primary bg-primary/10' : 'border-border text-secondary hover:text-foreground hover:bg-surface-raised'}`}
          >
            {showExtInput ? '隐藏 ext' : '显示 ext'}
          </button>
        </div>

        {/* Ext JSON input */}
        {showExtInput && (
          <div>
            <textarea
              value={extText}
              onChange={e => { setExtText(e.target.value); setExtError(null); }}
              placeholder='{"action":"create","taskId":"..."}'
              rows={3}
              className={`w-full resize-none rounded-lg border bg-surface px-3 py-2 text-xs font-mono text-foreground placeholder:text-secondary focus:outline-none focus:ring-1 focus:ring-primary ${extError ? 'border-red-400' : 'border-border'}`}
            />
            {extError && <p className="text-[11px] text-red-400 mt-0.5">{extError}</p>}
          </div>
        )}

        {/* Text + Send */}
        <div className="flex gap-2 items-end">
          <textarea
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={2}
            className="flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-secondary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!inputText.trim() || sending}
            className="shrink-0 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default IosCommView;
