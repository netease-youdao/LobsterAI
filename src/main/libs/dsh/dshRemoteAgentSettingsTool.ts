import { AgentSettingsPrivateTool } from '../../../shared/cowork/agentSettingsPrivacy';
import { DSH_SESSION_ID_PREFIX } from '../../../shared/dshEngine/hostConstants';
import { RemoteAgentSettingsAction, RemoteAgentSettingsSection } from '../../../shared/remote/agentSettings';
import { type RemoteOwner, RemoteRunStatus } from '../../../shared/remote/constants';
import type { CoworkStore } from '../../coworkStore';
import { sameOwner } from '../../remote/canonical';
import type { RemoteAgentSettingsProtocol } from '../../remote/remoteAgentSettingsProtocol';
import type { HostToolProvider } from './dshHostBridgeWiring';
import { DSH_REMOTE_BINDING_VERSION } from './dshRemoteTurnEvidence';

type ToolContext = Parameters<HostToolProvider['execute']>[2];
interface ReadDependencies {
  store: CoworkStore;
  owner(): RemoteOwner | null;
  routeEpoch(): number;
  assertActiveTurn(sessionId: string, requestId: string, agentId: string): void;
  protocol(): RemoteAgentSettingsProtocol | null;
}
const sections: ReadonlySet<string> = new Set([
  RemoteAgentSettingsSection.Identity, RemoteAgentSettingsSection.Memory, RemoteAgentSettingsSection.UserProfile,
]);
const validId = (v: string | undefined): v is string => typeof v === 'string' && /^[a-zA-Z0-9_:.@-]{1,256}$/u.test(v);
let active: ReadDependencies | undefined;

/** A stopped or replaced bridge cannot answer an in-flight tool call. */
export function attachDshRemoteAgentSettingsReader(deps: ReadDependencies): () => void {
  active = deps;
  return () => { if (active === deps) active = undefined; };
}

function resolveSource(deps: ReadDependencies, ctx: ToolContext) {
  const { coworkSessionId: id, sessionId: nativeId, remoteRequestId, agentId, callId } = ctx;
  if (ctx.signal?.aborted || !validId(id) || !validId(nativeId) || !validId(remoteRequestId) || !validId(agentId) || !validId(callId)) {
    throw new Error('CONVERSATION_SOURCE_INVALID');
  }
  deps.assertActiveTurn(id, remoteRequestId, agentId);
  const { remote } = deps.store;
  const account = deps.owner();
  const session = deps.store.getSession(id, 0);
  const mapping = remote.get<{ runId: string; remoteRunId: string; sessionKey: string; gatewayBootId: string }>(`gatewayRun:${id}`);
  const run = remote.run(id);
  const commandId = remote.get<string>(`runCommand:${id}`);
  if (!account || !session || session.parentSessionId || session.agentId !== agentId
    || (session.claudeSessionId !== nativeId && session.claudeSessionId !== DSH_SESSION_ID_PREFIX + nativeId) || !run || !commandId
    || (run.status !== RemoteRunStatus.Running && run.status !== RemoteRunStatus.WaitingApproval && run.status !== RemoteRunStatus.WaitingLocal)
    || mapping?.gatewayBootId !== DSH_REMOTE_BINDING_VERSION || mapping.runId !== remoteRequestId
    || mapping.sessionKey !== nativeId || mapping.remoteRunId !== run.runId
    || !remote.isTaskAdmitted(id) || !sameOwner(account, remote.owner(id))) throw new Error('CONVERSATION_SOURCE_INVALID');
  remote.assertNoDeletionEffect(id);
  remote.assertActor(id, account);
  deps.store.assertAgentAccess(agentId, account);
  return { agentId, commandId, runId: run.runId, owner: account, epoch: deps.routeEpoch(), callId };
}

export function createDshRemoteAgentSettingsProvider(): HostToolProvider {
  return {
    listDescriptors: () => [{
      name: AgentSettingsPrivateTool, deferLoading: true, isConcurrencySafe: true,
      description: 'Read identity, memory, or user profile settings for the current Agent in a connected phone conversation.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'section'], properties: {
        action: { type: 'string', enum: [RemoteAgentSettingsAction.Read] },
        section: { type: 'string', enum: [...sections] },
      } },
    }],
    async execute(name, args, ctx) {
      if (name !== AgentSettingsPrivateTool || !args || args.action !== RemoteAgentSettingsAction.Read
        || typeof args.section !== 'string' || !sections.has(args.section)
        || Object.keys(args).some(key => key !== 'action' && key !== 'section')) throw new Error('SETTINGS_INVALID_REQUEST');
      const deps = active;
      const protocol = deps?.protocol();
      if (!deps || !protocol) throw new Error('SETTINGS_UNAVAILABLE');
      const source = resolveSource(deps, ctx);
      const assertCurrent = () => {
        if (active !== deps || deps.protocol() !== protocol) throw new Error('CONVERSATION_SOURCE_INVALID');
        const current = resolveSource(deps, ctx);
        if (current.epoch !== source.epoch || !sameOwner(current.owner, source.owner)
          || current.commandId !== source.commandId || current.runId !== source.runId) throw new Error('CONVERSATION_SOURCE_INVALID');
      };
      const section = args.section as RemoteAgentSettingsSection;
      const snapshot = await protocol.readConversationSection(source, section, assertCurrent);
      assertCurrent();
      return { section, ...snapshot };
    },
  };
}
