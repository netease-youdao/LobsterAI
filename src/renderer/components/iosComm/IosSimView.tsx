/**
 * IosSimView — 模拟 iOS 发送 NIM 消息
 *
 * 构造一条假的 iOS NIM 消息，注入到 routeIncomingMessage 流程里，
 * 触发真实的 Server API 调用和自动回复，用于本地端到端测试。
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import WindowTitleBar from '../window/WindowTitleBar';

// ── Types ──────────────────────────────────────────────────────────────────

type ActionType = 'normal' | 'create' | 'update' | 'pin' | 'unpin' | 'delete' | 'ack';

interface SimForm {
  action: ActionType;
  taskId: string;
  title: string;
  text: string;
}

type LogEntry = {
  id: string;
  time: number;
  kind: 'info' | 'success' | 'error' | 'nim-log' | 'action';
  text: string;
  detail?: string;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function makeId(): string {
  return Math.random().toString(36).slice(2);
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

const ACTION_OPTIONS: { value: ActionType; label: string; desc: string }[] = [
  { value: 'normal', label: '普通消息', desc: '带 taskId 的文本消息，触发 AI 路由' },
  { value: 'create', label: '创建会话', desc: '新建任务会话，需要 taskId + title' },
  { value: 'update', label: '更新会话', desc: '修改会话标题，需要 taskId + title' },
  { value: 'pin',    label: '置顶会话', desc: '置顶指定任务，需要 taskId' },
  { value: 'unpin',  label: '取消置顶', desc: '取消置顶，需要 taskId' },
  { value: 'delete', label: '删除会话', desc: '软删除会话，需要 taskId' },
  { value: 'ack',    label: 'Ack',     desc: 'iOS 回执，只记录日志，不处理' },
];

// Which extra fields each action needs
const NEEDS: Record<ActionType, { taskId: boolean; title: boolean; text: boolean }> = {
  normal:  { taskId: true,  title: false, text: true },
  create:  { taskId: true,  title: true,  text: false },
  update:  { taskId: true,  title: true,  text: false },
  pin:     { taskId: true,  title: false, text: false },
  unpin:   { taskId: true,  title: false, text: false },
  delete:  { taskId: true,  title: false, text: false },
  ack:     { taskId: true,  title: false, text: false },
};

// ── Component ──────────────────────────────────────────────────────────────

interface IosSimViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const IosSimView: React.FC<IosSimViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [form, setForm] = useState<SimForm>({
    action: 'normal',
    taskId: '',
    title: '',
    text: '测试消息',
  });
  const [sending, setSending] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const needs = NEEDS[form.action];

  const addLog = useCallback((entry: Omit<LogEntry, 'id' | 'time'>) => {
    setLogs(prev => [...prev, { ...entry, id: makeId(), time: Date.now() }]);
  }, []);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Subscribe to NIM log / action events so we can see what happens downstream
  useEffect(() => {
    const unsubLog = (window.electron as any).ydNim.onLog(
      (entry: { text: string; time: number }) => {
        setLogs(prev => [...prev, { id: makeId(), time: entry.time, kind: 'nim-log', text: entry.text }]);
      }
    );
    const unsubAction = (window.electron as any).ydNim.onAction(
      (data: { action: string; taskId?: string; electronTaskId?: string; title?: string; text?: string }) => {
        setLogs(prev => [...prev, {
          id: makeId(), time: Date.now(), kind: 'action',
          text: `[路由结果] action=${data.action}`,
          detail: JSON.stringify(data, null, 2),
        }]);
      }
    );
    return () => { unsubLog(); unsubAction(); };
  }, []);

  const handleSet = useCallback(<K extends keyof SimForm>(key: K, value: SimForm[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleSend = useCallback(async () => {
    if (sending) return;
    setSending(true);

    const params: any = { action: form.action === 'normal' ? undefined : form.action };
    if (form.taskId.trim()) params.taskId = form.taskId.trim();
    if (needs.title && form.title.trim()) params.title = form.title.trim();
    if (needs.text) params.text = form.text.trim();

    addLog({
      kind: 'info',
      text: `发送模拟消息 → action=${form.action}`,
      detail: JSON.stringify(params, null, 2),
    });

    try {
      const result = await (window.electron as any).ydNim.simulateIosMessage(params);
      if (result?.success) {
        addLog({ kind: 'success', text: '✓ 消息已注入，等待处理结果…' });
      } else {
        addLog({ kind: 'error', text: `✗ 注入失败: ${result?.error ?? '未知错误'}` });
      }
    } catch (e: any) {
      addLog({ kind: 'error', text: `✗ IPC 异常: ${e?.message ?? String(e)}` });
    } finally {
      setSending(false);
    }
  }, [form, needs, sending, addLog]);

  const actionOption = ACTION_OPTIONS.find(o => o.value === form.action)!;

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
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M9 3v18" />
                  </svg>
                </button>
              )}
              {onNewChat && (
                <button type="button" onClick={onNewChat} className="p-1 rounded hover:bg-surface-raised text-secondary hover:text-foreground transition-colors">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              )}
              {updateBadge}
            </div>
          )}
          <h1 className="text-lg font-semibold text-foreground">模拟 iOS 发消息</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLogs([])}
            className="text-xs text-secondary hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-surface-raised"
          >
            清空日志
          </button>
          <WindowTitleBar inline />
        </div>
      </div>

      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* Form */}
        <div className="shrink-0 px-4 py-4 border-b border-border space-y-3">

          {/* Action selector */}
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Action（消息类型）</label>
            <div className="flex flex-wrap gap-1.5">
              {ACTION_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleSet('action', opt.value)}
                  className={`text-[11px] px-2.5 py-1 rounded-full border font-medium transition-colors ${
                    form.action === opt.value
                      ? 'bg-primary text-white border-primary'
                      : 'border-border text-secondary hover:text-foreground hover:bg-surface-raised'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-secondary">{actionOption.desc}</p>
          </div>

          {/* TaskId */}
          {needs.taskId && (
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">taskId</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={form.taskId}
                  onChange={e => handleSet('taskId', e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  className="flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-mono text-foreground placeholder:text-secondary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  type="button"
                  onClick={() => handleSet('taskId', generateUUID())}
                  className="shrink-0 text-[11px] px-2.5 py-1.5 rounded-lg border border-border text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
                >
                  生成 UUID
                </button>
              </div>
            </div>
          )}

          {/* Title */}
          {needs.title && (
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">title（会话标题）</label>
              <input
                type="text"
                value={form.title}
                onChange={e => handleSet('title', e.target.value)}
                placeholder="例：翻译这段话"
                className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-secondary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          {/* Text */}
          {needs.text && (
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">text（消息正文）</label>
              <input
                type="text"
                value={form.text}
                onChange={e => handleSet('text', e.target.value)}
                placeholder="输入消息内容"
                className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-secondary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          {/* Send button */}
          <button
            type="button"
            onClick={handleSend}
            disabled={sending}
            className="w-full py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? '处理中…' : `模拟发送 ${actionOption.label}`}
          </button>
        </div>

        {/* Log panel */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5 min-h-0 [scrollbar-gutter:stable]">
          {logs.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-secondary select-none">填写参数后点击「模拟发送」，日志会实时显示在这里</p>
            </div>
          )}
          {logs.map(entry => {
            const color =
              entry.kind === 'success' ? 'text-green-500' :
              entry.kind === 'error'   ? 'text-red-400' :
              entry.kind === 'action'  ? 'text-primary' :
              entry.kind === 'nim-log' ? 'text-secondary' :
                                         'text-foreground';
            return (
              <div key={entry.id} className="text-xs">
                <span className="text-secondary mr-1.5">{formatTime(entry.time)}</span>
                <span className={color}>{entry.text}</span>
                {entry.detail && (
                  <pre className="mt-0.5 ml-12 text-[10px] text-secondary bg-surface border border-border rounded p-1.5 overflow-x-auto">
                    {entry.detail}
                  </pre>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
};

export default IosSimView;
