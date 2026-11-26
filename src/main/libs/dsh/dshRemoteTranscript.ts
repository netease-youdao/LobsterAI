import { agentSettingsToolCallIds } from '../../../shared/cowork/agentSettingsPrivacy';
import type { CoworkMessage } from '../../coworkStore';
import type { DshCoworkStorePort } from '../agentEngine/dshRuntimeAdapter';
import { publicDshEventData } from './dshSettingsToolPrivacy';
import { DshChildEvent, readDshJournalMessage, record } from './dshSubagentHistory';

type Changed = (message: CoworkMessage, replaced: boolean) => void;

/** The caller commits the page and its native sequence cursor in the same transaction. */
export function applyDshTranscriptPage(store: DshCoworkStorePort, sessionId: string, storedNativeId: string,
  requestId: string, events: Record<string, unknown>[], changed: Changed): void {
  const messages = store.getSession(sessionId, Number.MAX_SAFE_INTEGER)?.messages ?? [];
  const userIndex = messages.findLastIndex(message => message.type === 'user');
  if (userIndex < 0 || messages[userIndex].metadata?.requestId !== requestId) {
    throw new Error('Cannot locate the original Cowork prompt for journal replay');
  }
  const tail = messages.slice(userIndex + 1);
  const privateIds = agentSettingsToolCallIds(tail);
  for (const raw of events) {
    const event = { ...raw, type: raw.type, seq: raw.seq, data: publicDshEventData(raw.type, raw.data, privateIds) };
    const seq = event.seq;
    const msg = readDshJournalMessage(storedNativeId, event);
    if (!msg || typeof seq !== 'number' || msg.type === 'user') continue;
    const metadata: NonNullable<CoworkMessage['metadata']> = { ...msg.metadata, seq, dshSessionId: storedNativeId, isStreaming: false };
    if (event.type === DshChildEvent.ToolResult) {
      const details = record(record(record(event.data).meta).lobsterToolResult);
      if (details.details) metadata.toolResultDetails = record(details.details);
      if (details.isError) metadata.isError = true;
    }
    if (tail.some(existing => existing.type === msg.type && existing.metadata?.seq === seq && !existing.metadata?.isThinking
      && (!existing.metadata.dshSessionId || existing.metadata.dshSessionId === storedNativeId))) continue;
    // An interrupted stream may have a partial assistant bubble with no committed journal seq yet.
    const partial = msg.type === 'assistant' && tail.find(existing => existing.type === msg.type
      && existing.metadata?.isStreaming && !existing.metadata?.isThinking && existing.metadata?.seq === undefined);
    if (partial) {
      store.updateMessageContent(sessionId, partial.id, msg.content, metadata);
      const updated = { ...partial, content: msg.content, metadata };
      tail[tail.indexOf(partial)] = updated;
      changed(updated, true);
    } else {
      const added = store.addMessage(sessionId, { type: msg.type, content: msg.content, metadata });
      tail.push(added);
      changed(added, false);
    }
  }
}
