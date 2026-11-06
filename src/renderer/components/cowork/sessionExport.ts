import { extractPastedTextBlocks } from '../../../shared/cowork/pastedText';
import type { CoworkMessage, CoworkSession } from '../../types/cowork';

export const CoworkTextExportFormat = {
  Markdown: 'md',
  Json: 'json',
} as const;
export type CoworkTextExportFormat =
  typeof CoworkTextExportFormat[keyof typeof CoworkTextExportFormat];

type Translate = (key: string) => string;

const toMarkdownFence = (text: string): string => {
  const longestBacktickRun = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}\n${text}\n${fence}`;
};

export function mergeCoworkTextExportMessages(
  storedMessages: CoworkMessage[],
  currentMessages: CoworkMessage[],
): CoworkMessage[] {
  if (currentMessages.length === 0) return storedMessages;
  if (storedMessages.length === 0) return currentMessages;

  const currentById = new Map(currentMessages.map(message => [message.id, message]));
  const storedIds = new Set(storedMessages.map(message => message.id));
  const merged = storedMessages.map(message => currentById.get(message.id) ?? message);

  for (const message of currentMessages) {
    if (!storedIds.has(message.id)) {
      merged.push(message);
    }
  }

  return merged;
}

export function buildCoworkSessionMarkdown(
  session: CoworkSession,
  messages: CoworkMessage[],
  t: Translate,
): string {
  const lines: string[] = [];
  lines.push(`# ${session.title}`);
  lines.push('');
  lines.push(`> ${t('coworkExportCreatedAt')}: ${new Date(session.createdAt).toLocaleString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const msg of messages) {
    if (msg.type === 'user') {
      lines.push('## 🧑 User');
      lines.push('');
      if (msg.metadata?.selectedTextSnippets?.length) {
        lines.push(`### ${t('coworkSelectedTextExportHeading')}`);
        lines.push('');
        for (const snippet of msg.metadata.selectedTextSnippets) {
          lines.push(...snippet.text.split('\n').map(line => `> ${line}`));
          lines.push('');
        }
      }
      const { text, blocks: pastedTexts } = extractPastedTextBlocks(msg.content);
      lines.push(text);
      lines.push('');
      for (const pastedText of pastedTexts) {
        lines.push(`### ${t('coworkPastedTextTitle')}`);
        lines.push('');
        lines.push(toMarkdownFence(pastedText.text));
        lines.push('');
      }
    } else if (msg.type === 'assistant') {
      lines.push('## 🤖 Assistant');
      lines.push('');
      lines.push(msg.content);
      lines.push('');
    } else if (msg.type === 'tool_use' && msg.metadata?.toolName) {
      lines.push(`### 🔧 Tool: ${msg.metadata.toolName}`);
      lines.push('');
      if (msg.metadata.toolInput) {
        lines.push('```json');
        lines.push(JSON.stringify(msg.metadata.toolInput, null, 2));
        lines.push('```');
        lines.push('');
      }
    } else if (msg.type === 'tool_result') {
      lines.push('#### Tool Result');
      lines.push('');
      lines.push('```');
      lines.push(msg.content.slice(0, 2000) + (msg.content.length > 2000 ? '\n... (truncated)' : ''));
      lines.push('```');
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function buildCoworkSessionJSON(
  session: CoworkSession,
  messages: CoworkMessage[],
): string {
  return JSON.stringify({
    title: session.title,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    status: session.status,
    messages: messages.map(msg => ({
      type: msg.type,
      content: msg.content,
      timestamp: new Date(msg.timestamp).toISOString(),
      ...(msg.metadata?.toolName ? { toolName: msg.metadata.toolName } : {}),
      ...(msg.metadata?.toolInput ? { toolInput: msg.metadata.toolInput } : {}),
      ...(msg.metadata?.selectedTextSnippets?.length ? { selectedTextSnippets: msg.metadata.selectedTextSnippets } : {}),
    })),
  }, null, 2);
}
