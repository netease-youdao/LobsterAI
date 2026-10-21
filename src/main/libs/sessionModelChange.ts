import { CoworkSystemMessageKind } from '../../common/coworkSystemMessages';
import type { CoworkModelChange } from '../../shared/cowork/modelChange';
import { ProviderRegistry } from '../../shared/providers/constants';
import type { CoworkSession, CoworkStore } from '../coworkStore';
import { resolveRawApiConfig } from './claudeSettings';

function effectiveModelRef(store: CoworkStore, session: CoworkSession): string {
  const explicitModel = session.modelOverride.trim() || store.getAgent(session.agentId)?.model?.trim();
  if (explicitModel) return explicitModel;
  const { config, providerMetadata } = resolveRawApiConfig();
  if (!config?.model) return '';
  const providerId = ProviderRegistry.getOpenClawProviderId(providerMetadata?.providerName ?? '');
  return providerId ? `${providerId}/${config.model}` : config.model;
}

function isSameModelSelection(change: CoworkModelChange): boolean {
  if (change.previousPresetId || change.nextPresetId) {
    return change.previousPresetId === change.nextPresetId;
  }
  return change.previousModelRef === change.nextModelRef
    || ((!change.previousModelRef.includes('/') || !change.nextModelRef.includes('/'))
      && change.previousModelRef.split('/').slice(-1)[0] === change.nextModelRef.split('/').slice(-1)[0]);
}

/** Persist the net model change until the conversation continues. */
export function recordSessionModelChange(
  store: CoworkStore,
  previous: CoworkSession | null,
  current: CoworkSession,
): CoworkSession {
  // The loaded tail may contain only assistant/tool messages from a long turn.
  if (!previous || !store.getLatestUserMessage(previous.id)) return current;
  const previousModelRef = effectiveModelRef(store, previous);
  const nextModelRef = effectiveModelRef(store, current);
  if (!previousModelRef || !nextModelRef) return current;

  const modelChange: CoworkModelChange = {
    previousModelRef,
    nextModelRef,
    previousPresetId: previous.modelPresetId,
    nextPresetId: current.modelPresetId,
  };
  if (isSameModelSelection(modelChange)) return current;

  // Only trailing notices are pending; conversation messages keep earlier changes intact.
  const pendingNoticeIds: string[] = [];
  for (let index = current.messages.length - 1; index >= 0; index -= 1) {
    const message = current.messages[index];
    const change = message.metadata?.modelChange;
    if (message.type !== 'system' || message.metadata?.kind !== CoworkSystemMessageKind.ModelChanged || !change) break;
    pendingNoticeIds.push(message.id);
    modelChange.previousModelRef = change.previousModelRef;
    modelChange.previousPresetId = change.previousPresetId;
  }

  for (const messageId of pendingNoticeIds) {
    store.deleteMessage(current.id, messageId);
  }
  if (!isSameModelSelection(modelChange)) {
    store.addMessage(current.id, {
      type: 'system',
      content: '',
      metadata: { kind: CoworkSystemMessageKind.ModelChanged, modelChange },
    });
  }
  return store.getSession(current.id) ?? current;
}
