import { payloadHash } from '../../remote/canonical';

const PLUGIN_ID = 'lobster-agent-settings';
const TOOL_NAME = 'lobsterai_agent_settings';
export interface SettingsApprovalIntent {
  operationId: string; commandId: string; runId: string; toolCallId: string; agentId: string; section: string;
  expectedRevision: string; proposedDigest: string; changeKind: string; bindingId: string; bindingVersion: string;
  accountEpoch: string; dataSpaceId: string; dataGeneration: string; deviceId: string;
}
interface Pending {
  sessionKey: string; agentId: string; toolCallId: string; description: string; title: string; digest: string;
  isCurrent(): boolean;
}
const pending = new Map<string, Pending>();
const key = (sessionKey: string, toolCallId: string): string => JSON.stringify([sessionKey, toolCallId]);

export function settingsApprovalDigest(intent: SettingsApprovalIntent): string {
  return payloadHash({ kind: 'agent_settings_conversation_v1', ...intent });
}

/** Only a host-prepared proposal can opt into the settings approval digest contract. */
export function registerSettingsApproval(request: Pending): () => void {
  const id = key(request.sessionKey, request.toolCallId);
  if (pending.has(id)) throw new Error('SETTINGS_OPERATION_PENDING');
  pending.set(id, request);
  return () => { if (pending.get(id) === request) pending.delete(id); };
}

export function trustedSettingsApproval(request: Record<string, unknown>): { digest: string; title: string; summary: string; remoteSafe: boolean } | null {
  if (request.pluginId !== PLUGIN_ID || request.toolName !== TOOL_NAME || typeof request.sessionKey !== 'string'
    || typeof request.toolCallId !== 'string' || request.scope != null || request.detail != null) return null;
  const match = pending.get(key(request.sessionKey, request.toolCallId));
  if (!match || !match.isCurrent() || request.agentId !== match.agentId || request.title !== match.title || request.description !== match.description
    || !Array.isArray(request.allowedDecisions) || request.allowedDecisions.length !== 2
    || !request.allowedDecisions.includes('allow-once') || !request.allowedDecisions.includes('deny')) return null;
  return { digest: match.digest, title: match.title, summary: match.description, remoteSafe: true };
}

/** Exact changed range, not a model-authored reassuring summary. Oversized previews stay local. */
export function settingsChangePreview(before: string, after: string): string {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const removed = before.slice(start, before.length - end), added = after.slice(start, after.length - end);
  const preview = `− ${JSON.stringify(removed)}\n+ ${JSON.stringify(added)}`;
  if (Buffer.byteLength(preview) > 1800) throw new Error('LOCAL_ACTION_REQUIRED');
  return preview;
}
