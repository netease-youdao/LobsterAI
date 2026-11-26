import { createHash } from 'node:crypto';

import { SubagentCollaborationMode } from '../../../shared/agent/constants';
import type { RemoteOwner } from '../../../shared/remote/constants';
import type { CoworkStore } from '../../coworkStore';
import { sameOwner } from '../../remote/canonical';
import { assertDesktopInputDispatchCurrent, desktopInputCaptureEnabled, waitForDesktopInputCapture } from '../../remote/desktopInputMetadata';
import {
  assertRemoteExecutionPermit, currentRemoteExecution, DSH_REMOTE_BINDING_VERSION, markRemoteExecutionDispatched,
} from '../../remote/sessionCommandService';
import type { CoworkRemoteTurnOptions } from '../agentEngine/types';
import { assertAgentSettingsLocalWriteAllowed } from '../agentSettingsConversation/runtime';

interface NativeBinding {
  runId: string;
  remoteRunId: string;
  sessionKey: string;
  gatewayBootId: string;
}

/** Reserve desktop work before asynchronous file preparation and preserve the mobile command's reservation. */
export function reserveCoworkInput(store: CoworkStore, id: string, prompt: string) {
  const execution = currentRemoteExecution();
  const local = !execution?.runId;
  const run = store.remote.transaction(() => {
    if (local) {
      store.remote.beginRun(id);
      store.remote.prepareLocalDispatch(id, { prompt });
    }
    const reserved = store.remote.run(id);
    if (!reserved || (!local && reserved.runId !== execution?.runId)) throw new Error('Execution reservation changed');
    return reserved;
  });
  return {
    localReservation: local ? { sessionId: id, runId: run.runId } : undefined,
    async captureInput(capture: (deadline: number) => Promise<void>, enabled: () => boolean, checkAccount: () => void) {
      await waitForDesktopInputCapture(deadline => capture(deadline)
        .catch(error => console.warn('[RemoteFiles] Input synchronization deferred', error)), desktopInputCaptureEnabled(enabled));
      const check = () => assertDesktopInputDispatchCurrent(store.remote, id, run, local, () => {
        checkAccount();
        const current = store.remote.run(id);
        if (current?.runId !== run.runId || current.status !== run.status || !store.getSession(id, 0)) throw new Error('Execution reservation changed');
        store.remote.assertNoDeletionEffect(id);
        assertRemoteExecutionPermit();
      });
      check();
      return check;
    },
  };
}

/** Wait for native admission only for a phone submission. The desktop keeps its optimistic IPC response. */
export function prepareCoworkSubmission(store: CoworkStore, sessionId: string,
  owner: () => RemoteOwner | null, localRequestId?: string, hostSupportsEvidence = true) {
  const source = currentRemoteExecution();
  const reserved = store.remote.run(sessionId);
  const mobile = Boolean(source?.commandId && source.runId);
  if (!reserved || (mobile && (source?.preparedSessionId !== sessionId || source.runId !== reserved.runId))) {
    throw new Error('Execution reservation changed');
  }
  const runId = reserved.runId;
  const requestId = mobile ? 'mobile-' + createHash('sha256').update(runId).digest('hex') : localRequestId;
  const session = store.getSession(sessionId, 0);
  if (!session || (mobile && session.parentSessionId)) throw new Error('Session unavailable');
  const agent = store.getAgent(session.agentId);
  const actor = source?.owner ?? owner();
  const candidates = mobile && agent ? store.listVisibleAgents(actor).filter(target => target.enabled
    && store.agentOwnership.canPublish(target.id, actor)
    && (agent.subagentCollaborationMode === SubagentCollaborationMode.All
      || agent.subagentCollaborationMode === SubagentCollaborationMode.Allowlist
      && agent.subagentAllowAgentIds.includes(target.id))) : [];
  const allowedAgentIds = [...new Set([session.agentId, ...candidates.map(target => target.id)])];
  const versions = new Map(allowedAgentIds.map(id => [id, store.agentOwnership.get(id)?.version]));
  const checkGrant = source?.stillPermitted;
  const checkBinding = source?.assertAgentBinding;
  let sent = false;
  let accept: () => void;
  const admitted = new Promise<void>(resolve => { accept = resolve; });
  const hooks: CoworkRemoteTurnOptions = {
    allowedAgentIds,
    assertDelegate(targetId) {
      if (!mobile || !actor || !sameOwner(actor, owner()) || store.remote.run(sessionId)?.runId !== runId
        || !allowedAgentIds.includes(targetId)) throw new Error('Agent authorization changed');
      store.remote.assertNoDeletionEffect(sessionId);
      store.remote.assertActor(sessionId, actor);
      const parent = store.getAgent(session.agentId);
      const child = store.getAgent(targetId);
      if (!parent?.enabled || !child?.enabled || !store.agentOwnership.canPublish(targetId, actor)
        || !store.agentOwnership.canPublish(parent.id, actor)
        || store.agentOwnership.get(targetId)?.version !== versions.get(targetId)
        || store.agentOwnership.get(parent.id)?.version !== versions.get(parent.id)
        || (targetId !== parent.id && parent.subagentCollaborationMode !== SubagentCollaborationMode.All
          && !(parent.subagentCollaborationMode === SubagentCollaborationMode.Allowlist
            && parent.subagentAllowAgentIds.includes(targetId)))) throw new Error('Agent authorization changed');
    },
    beforeDispatch(nativeId, nativeRequestId) {
      if (!nativeId || !nativeRequestId || (requestId && nativeRequestId !== requestId)
        || (actor ? !sameOwner(actor, owner()) : owner() !== null)
        || (mobile && (!checkGrant?.() || !actor))) throw new Error('Execution authorization changed');
      assertAgentSettingsLocalWriteAllowed(session.agentId);
      assertRemoteExecutionPermit();
      checkBinding?.();
      store.remote.assertActor(sessionId, actor);
      store.remote.assertNoDeletionEffect(sessionId);
      if (mobile) {
        for (const [id, version] of versions) {
          if (!store.getAgent(id)?.enabled || store.agentOwnership.get(id)?.version !== version
            || !store.agentOwnership.canPublish(id, actor)) throw new Error('Agent authorization changed');
        }
      }
      const key = `gatewayRun:${sessionId}`;
      store.remote.transaction(() => {
        const prior = store.remote.get<NativeBinding>(key);
        if (prior?.remoteRunId === runId && (prior.sessionKey !== nativeId || prior.runId !== nativeRequestId)) {
          throw new Error('Native execution identity changed');
        }
        store.remote.markExecutionDispatch(sessionId, runId);
        store.remote.put(key, { runId: nativeRequestId, remoteRunId: runId, sessionKey: nativeId,
          gatewayBootId: DSH_REMOTE_BINDING_VERSION });
        store.remote.markRunDispatched(sessionId);
      });
      if (mobile && !sent) markRemoteExecutionDispatched();
      sent = true;
    },
    onAccepted(nativeId, nativeRequestId) {
      const binding = store.remote.get<NativeBinding>(`gatewayRun:${sessionId}`);
      if (!sent || binding?.remoteRunId !== runId || binding.runId !== nativeRequestId
        || binding.sessionKey !== nativeId) throw new Error('Native acceptance does not match the reserved turn');
      accept();
    },
  };
  if (!mobile && !hostSupportsEvidence) {
    store.remote.markExecutionDispatch(sessionId, runId);
    store.remote.markRunDispatched(sessionId);
  }
  return {
    options: mobile ? { requestId, remoteTurn: hooks } : { requestId, localTurnEvidence: hostSupportsEvidence ? hooks : undefined },
    awaitAdmission: async (completion: Promise<void>): Promise<void> => {
      if (mobile) await Promise.race([admitted, completion.then(() => {
        throw new Error('DSH admission could not be confirmed');
      })]);
    },
  };
}
