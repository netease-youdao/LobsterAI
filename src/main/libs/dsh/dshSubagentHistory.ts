import type { CoworkMessage } from '../../coworkStore';
import { publicDshEventData } from './dshSettingsToolPrivacy';
import type { DshSessionAddress, DshTypertClient } from './dshTypertClient';

export const DshChildEvent = {
  Catalog: 'subagent/catalog',
  User: 'user/message',
  Assistant: 'assistant/message',
  ToolCall: 'tool/call',
  ToolResult: 'tool/result',
  Settled: 'subagent-settled',
  Activation: 'activation',
} as const;

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(record).filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

// dsh appends this block to a parent's delegation prompt in its durable journal.
const deliveryGuidance = 'Your final answer is delivered automatically if your parent is still online. '
  + 'Include the result and relevant evidence in that answer; the parent does not receive your full transcript, '
  + 'tool output, or reasoning. If your last action is a message to your parent, the completion notice omits '
  + 'your final answer; include the result and relevant evidence in that message.';

function toolInput(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
}

export function readDshJournalMessage(runId: string, event: Record<string, unknown>): CoworkMessage | undefined {
  const data = record(event.data);
  const message = record(data.message);
  const id = `${runId}/${event.seq}`;
  const timestamp = Number(event.time);
  const content = textContent(message.content ?? data.content);
  switch (event.type) {
    case DshChildEvent.User: {
      // dsh also journals system context as user messages. Show the actual delegation and follow-ups.
      if (!['user', 'agent-message'].includes(String(record(data.source).kind)) || !content) return;
      const blocks = data.content;
      const prompt = Array.isArray(blocks) && blocks.length > 1 && record(blocks.at(-1)).text === deliveryGuidance
        ? textContent(blocks.slice(0, -1)) : content;
      return { id, timestamp, type: 'user', content: prompt };
    }
    case DshChildEvent.Assistant:
      if (content) return { id, timestamp, type: 'assistant', content };
      return;
    case DshChildEvent.ToolCall: {
      const toolName = String(data.name ?? '');
      return { id, timestamp, type: 'tool_use', content: toolName, metadata: {
        toolUseId: String(data.callId), toolName, toolInput: toolInput(data.arguments),
      } };
    }
    case DshChildEvent.ToolResult:
      return { id, timestamp, type: 'tool_result', content, metadata: {
        toolUseId: String(message.toolCallId ?? record(message.source).callId ?? data.callId),
        isError: message.isError === true,
      } };
    default:
      return;
  }
}

/** Read a consistent cut backwards, stopping at the child's descriptor instead of showing a forked parent's transcript. */
export async function readDshChildHistory(
  client: Pick<DshTypertClient, 'getSessionEvents'>,
  address: Extract<DshSessionAddress, { kind: 'subagent' }>,
  descriptorSeq: number,
  runId: string,
): Promise<CoworkMessage[]> {
  const pages: Record<string, unknown>[][] = [];
  let throughSeq: number | undefined;
  let beforeSeq: number | undefined;
  for (;;) {
    const page = await client.getSessionEvents(address, { maxMessages: 100, throughSeq, beforeSeq });
    const entries = Array.isArray(page.records) ? page.records.map(entry => record(record(entry).event)) : [];
    pages.push(entries.filter(event => typeof event.seq === 'number' && event.seq > descriptorSeq));
    const first = entries[0]?.seq;
    if (!page.hasMore || typeof first !== 'number' || first <= descriptorSeq) break;
    if (beforeSeq !== undefined && first >= beforeSeq) throw new Error('Subagent history cursor did not advance');
    beforeSeq = first;
    if (typeof page.cursor === 'number') throughSeq ??= page.cursor;
  }
  const privateIds = new Set<string>();
  return pages.reverse().flat().flatMap(event => {
    const message = readDshJournalMessage(runId, { ...event, data: publicDshEventData(event.type, event.data, privateIds) });
    return message ? [message] : [];
  });
}
