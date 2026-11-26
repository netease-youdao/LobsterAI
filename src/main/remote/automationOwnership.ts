import type { RemoteOwner } from '../../shared/remote/constants';
import type { CoworkStartOptions } from '../libs/agentEngine/types';
import { DSH_REMOTE_BINDING_VERSION } from '../libs/dsh/dshRemoteTurnEvidence';
import { sameOwner } from './canonical';
import type { RemoteStore } from './remoteStore';

/** Ownership hooks supplied by the product store. Migration and standalone fixtures run locally. */
export interface AutomationOwnershipPort {
  remote?: RemoteStore;
  remoteCreationOwner?: () => RemoteOwner | null;
  agentOwnership?: { canView(agentId: string, actor: RemoteOwner | null): boolean };
}

export const imAutomationSourceId = (platform: string, instanceId = 'default'): string => `im:${platform}:${instanceId}`;
export const scheduledAutomationSourceId = (taskId: string): string => `cron:${taskId}`;

export function canUseAutomationSource(store: AutomationOwnershipPort, sourceId: string): boolean {
  return store.remote?.canUseSource(sourceId, store.remoteCreationOwner?.() ?? null) ?? true;
}

export function automationSessionOptions(store: AutomationOwnershipPort, sourceId: string) {
  if (!canUseAutomationSource(store, sourceId)) throw new Error('Automation belongs to another account');
  return {
    owner: store.remote?.sourceOwner(sourceId) ?? null,
    ownershipSource: 'bound_automation',
    publicationSourceId: sourceId,
  };
}

/** DSH emits sessionStatus(running) before prompt admission. Bind only that new run. */
export function prepareAutomationTurn(store: AutomationOwnershipPort, sessionId: string, sourceId: string): Pick<CoworkStartOptions, 'checkAccount' | 'localTurnEvidence'> {
  const remote = store.remote;
  const owner = remote?.sourceOwner(sourceId) ?? null;
  if (!remote || !owner) return {};
  const checkAccount = (): void => {
    if (!sameOwner(owner, remote.sourceOwner(sourceId)) || !sameOwner(owner, store.remoteCreationOwner?.() ?? null)) {
      throw new Error('Automation belongs to another account');
    }
    remote.assertActor(sessionId, owner);
    remote.assertNoDeletionEffect(sessionId);
  };
  checkAccount();
  // An existing anonymous conversation remains local after its original source is bound.
  if (!sameOwner(remote.owner(sessionId), owner)) return { checkAccount };
  const previousRun = remote.run(sessionId)?.runId;
  const key = `gatewayRun:${sessionId}`;
  type Binding = { sessionKey: string; runId: string; remoteRunId: string; gatewayBootId: string };
  return {
    checkAccount,
    localTurnEvidence: {
      beforeDispatch(nativeId, requestId) {
        checkAccount();
        remote.transaction(() => {
          const run = remote.run(sessionId);
          const existing = remote.get<Binding>(key);
          if (!run || !nativeId || !requestId || run.runId === previousRun || existing &&
            (existing.remoteRunId !== run.runId || existing.sessionKey !== nativeId || existing.runId !== requestId)) {
            throw new Error('Automation run identity changed');
          }
          remote.bindExecutionSource(sessionId, sourceId);
          if (!remote.recordExternalExecution(sessionId, requestId)) throw new Error('Automation dispatch ownership changed');
          remote.markExecutionDispatch(sessionId, run.runId);
          remote.put(key, { sessionKey: nativeId, runId: requestId, remoteRunId: run.runId, gatewayBootId: DSH_REMOTE_BINDING_VERSION });
        });
        remote.markRunDispatched(sessionId);
      },
      onAccepted(nativeId, requestId) {
        const binding = remote.get<Binding>(key);
        if (!binding || binding.remoteRunId !== remote.run(sessionId)?.runId || binding.sessionKey !== nativeId || binding.runId !== requestId) {
          throw new Error('Automation acceptance does not match the bound run');
        }
      },
    },
  };
}

export function filterOwnedInstances<T extends { instanceId: string }>(instances: T[], platform: string, store: RemoteStore, owner: RemoteOwner | null): T[] {
  return instances.filter(instance => {
    return store.canUseSource(imAutomationSourceId(platform, instance.instanceId), owner);
  });
}
