import { agentSettingsPublicInput, agentSettingsPublicResult, isAgentSettingsPrivateTool } from '../../../shared/cowork/agentSettingsPrivacy';

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Reduce settings tool data before any Cowork write or renderer event, including history replay. */
export function publicDshEventData(type: unknown, value: unknown, privateIds: Set<string>): Record<string, unknown> {
  const data = object(value);
  if (type === 'tool/call' && isAgentSettingsPrivateTool(data.name)) {
    if (typeof data.callId === 'string') privateIds.add(data.callId);
    return { name: data.name, callId: data.callId, arguments: agentSettingsPublicInput(data.arguments), turn: data.turn };
  }
  if (type === 'tool/result') {
    const message = object(data.message);
    const callId = message.callId ?? message.toolCallId ?? object(message.source).callId ?? data.callId;
    if (isAgentSettingsPrivateTool(message.name ?? data.name) || typeof callId === 'string' && privateIds.has(callId)) {
      const content = message.content ?? data.content;
      return { callId, turn: data.turn, isError: data.isError === true || message.isError === true,
        content: JSON.stringify(agentSettingsPublicResult(Array.isArray(content) ? { content } : content)) };
    }
  }
  return data;
}
