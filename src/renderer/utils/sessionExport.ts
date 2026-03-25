import type { CoworkSession, CoworkMessage, CoworkMessageMetadata } from '../types/cowork';

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function roleLabel(type: string): string {
  switch (type) {
    case 'user': return 'User';
    case 'assistant': return 'Assistant';
    case 'tool_use': return 'Tool Use';
    case 'tool_result': return 'Tool Result';
    case 'system': return 'System';
    default: return type;
  }
}

function formatToolMeta(meta: CoworkMessageMetadata | undefined): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (meta.toolName) parts.push(`**Tool:** \`${meta.toolName}\``);
  if (meta.toolInput) {
    try {
      const inputStr = JSON.stringify(meta.toolInput, null, 2);
      if (inputStr.length <= 2000) {
        parts.push(`**Input:**\n\`\`\`json\n${inputStr}\n\`\`\``);
      }
    } catch { /* skip */ }
  }
  if (meta.toolResult) {
    const result = meta.toolResult.length > 4000
      ? meta.toolResult.slice(0, 4000) + '\n… (truncated)'
      : meta.toolResult;
    parts.push(`**Result:**\n\`\`\`\n${result}\n\`\`\``);
  }
  if (meta.error) parts.push(`**Error:** ${meta.error}`);
  return parts.join('\n\n');
}

export function sessionToMarkdown(session: CoworkSession): string {
  const lines: string[] = [];

  lines.push(`# ${session.title}`);
  lines.push('');
  lines.push(`- **Session ID:** ${session.id}`);
  lines.push(`- **Created:** ${formatTimestamp(session.createdAt)}`);
  lines.push(`- **Updated:** ${formatTimestamp(session.updatedAt)}`);
  lines.push(`- **Status:** ${session.status}`);
  if (session.cwd) lines.push(`- **Working Directory:** \`${session.cwd}\``);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of session.messages) {
    const isThinking = msg.metadata?.isThinking;
    if (isThinking) continue;

    const label = roleLabel(msg.type);
    const time = formatTimestamp(msg.timestamp);

    lines.push(`## ${label}`);
    lines.push(`<sub>${time}</sub>`);
    lines.push('');

    if (msg.type === 'tool_use' || msg.type === 'tool_result') {
      const toolInfo = formatToolMeta(msg.metadata);
      if (toolInfo) {
        lines.push(toolInfo);
        lines.push('');
      }
      if (msg.content.trim()) {
        lines.push(msg.content);
        lines.push('');
      }
    } else {
      if (msg.content.trim()) {
        lines.push(msg.content);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON export
// ---------------------------------------------------------------------------

interface ExportedMessage {
  id: string;
  type: string;
  content: string;
  timestamp: number;
  datetime: string;
  metadata?: CoworkMessageMetadata;
}

interface ExportedSession {
  id: string;
  title: string;
  status: string;
  cwd: string;
  executionMode: string;
  createdAt: number;
  updatedAt: number;
  createdAtFormatted: string;
  updatedAtFormatted: string;
  messageCount: number;
  messages: ExportedMessage[];
}

function toExportedMessage(msg: CoworkMessage): ExportedMessage {
  const out: ExportedMessage = {
    id: msg.id,
    type: msg.type,
    content: msg.content,
    timestamp: msg.timestamp,
    datetime: formatTimestamp(msg.timestamp),
  };
  if (msg.metadata && Object.keys(msg.metadata).length > 0) {
    out.metadata = msg.metadata;
  }
  return out;
}

export function sessionToJson(session: CoworkSession): string {
  const exported: ExportedSession = {
    id: session.id,
    title: session.title,
    status: session.status,
    cwd: session.cwd,
    executionMode: session.executionMode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    createdAtFormatted: formatTimestamp(session.createdAt),
    updatedAtFormatted: formatTimestamp(session.updatedAt),
    messageCount: session.messages.length,
    messages: session.messages.map(toExportedMessage),
  };
  return JSON.stringify(exported, null, 2);
}

export function sessionToJsonl(session: CoworkSession): string {
  const lines: string[] = [];

  const header = {
    record: 'session',
    id: session.id,
    title: session.title,
    status: session.status,
    cwd: session.cwd,
    executionMode: session.executionMode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
  lines.push(JSON.stringify(header));

  for (const msg of session.messages) {
    const exported = toExportedMessage(msg);
    lines.push(JSON.stringify({ record: 'message', ...exported }));
  }

  return lines.join('\n') + '\n';
}
