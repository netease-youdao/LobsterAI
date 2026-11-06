import { SettingsRuntime } from './coordinator';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Persistence-only copy. The running model receives the original protected read. */
export function settingsTranscriptMessage<T>(message: T): T {
  const raw = record(message);
  if (raw.role === 'toolResult' && raw.toolName === SettingsRuntime.Tool) {
    return { role: raw.role, toolCallId: raw.toolCallId, toolName: SettingsRuntime.Tool, isError: raw.isError === true, timestamp: raw.timestamp,
      content: [{ type: 'text', text: JSON.stringify({ settingsContentOmitted: true }) }] } as T;
  }
  if (raw.role !== 'assistant' || !Array.isArray(raw.content)) return message;
  let changed = false;
  const content = raw.content.map((entry: unknown) => {
    const block = record(entry);
    if (block.type !== 'toolCall' || block.name !== SettingsRuntime.Tool) return entry;
    const args = record(block.arguments); changed = true;
    const safe: Record<string, unknown> = { settingsContentOmitted: true };
    if (args.action === 'read' || args.action === 'update') safe.action = args.action;
    if (['identity', 'memory', 'userProfile'].includes(String(args.section))) safe.section = args.section;
    if (['append', 'replace_selection', 'replace_all', 'clear'].includes(String(args.changeKind))) safe.changeKind = args.changeKind;
    return { type: block.type, id: block.id, name: SettingsRuntime.Tool, arguments: safe };
  });
  return changed ? { ...raw, content } as T : message;
}
