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
  normal_right: '普通(Electron)',
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

// ── Module-level message cache (survives tab switches) ─────────────────────

let persistedMessages: (MessageEntry & { id: string })[] = [];

// ── Component ──────────────────────────────────────────────────────────────

interface IosCommViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const IosCommView: React.FC<IosCommViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [messages, setMessages] = useState<(MessageEntry & { id: string })[]>(() => persistedMessages);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Sync to module-level cache so remounts restore the list
  useEffect(() => {
    persistedMessages = messages;
  }, [messages]);

  const addEntry = useCallback((entry: MessageEntry) => {
    setMessages(prev => [...prev, { ...entry, id: makeId() }]);
  }, []);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Subscribe to IPC events and load history on mount
  useEffect(() => {
    // Fetch buffered history from main process first
    (async () => {
      try {
        const history = await (window.electron as any).ydNim.getHistory() as Array<{ channel: string; data: any }>;
        if (history.length > 0) {
          const entries: (MessageEntry & { id: string })[] = [];
          for (const item of history) {
            if (item.channel === 'yd-nim:message-received') {
              const d = item.data;
              entries.push({ kind: 'received', id: makeId(), from: d.from, text: d.text, serverId: d.serverId, time: d.time, ext: d.ext });
            } else if (item.channel === 'yd-nim:message-sent') {
              const d = item.data;
              entries.push({ kind: 'sent', id: makeId(), text: d.text, time: d.time, serverId: d.serverId, error: d.error, ext: d.ext, isAutoReply: d.isAutoReply });
            } else if (item.channel === 'yd-nim:log') {
              const d = item.data;
              entries.push({ kind: 'log', id: makeId(), text: d.text, time: d.time });
            }
          }
          if (entries.length > 0) {
            setMessages(prev => {
              if (prev.length === 0) {
                persistedMessages = entries;
                return entries;
              }
              // Merge ring buffer with current state, deduplicate by kind+time+text fingerprint
              const existingKeys = new Set(prev.map(m => `${m.kind}:${m.time}:${m.text}`));
              const toAdd = entries.filter(e => !existingKeys.has(`${e.kind}:${e.time}:${e.text}`));
              if (toAdd.length === 0) return prev;
              const merged = [...prev, ...toAdd].sort((a, b) => a.time - b.time);
              persistedMessages = merged;
              return merged;
            });
          }
        }
      } catch {
        // ignore — main process may not have the handler yet
      }
    })();

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
            onClick={() => { setMessages([]); persistedMessages = []; }}
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
    </div>
  );
};

export default IosCommView;
