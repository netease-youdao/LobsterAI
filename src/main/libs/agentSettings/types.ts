export const AgentSettingsSection = {
  Model: 'model', Collaboration: 'collaboration', Identity: 'identity', Memory: 'memory', UserProfile: 'userProfile',
} as const;
export type AgentSettingsSection = typeof AgentSettingsSection[keyof typeof AgentSettingsSection];
export const AgentSettingsSource = { App: 'app', Conversation: 'conversation' } as const;
export const AgentSettingsAction = { Read: 'read', DirectUpdate: 'directUpdate', ConversationUpdate: 'conversationUpdate' } as const;
export type AgentSettingsAction = typeof AgentSettingsAction[keyof typeof AgentSettingsAction];
export const AgentSettingsPhase = { Prepared: 'prepared', Applying: 'applying', Persisted: 'persisted', Applied: 'applied', Rejected: 'rejected', Reconciling: 'reconciling', NoChange: 'no_change' } as const;
export const AgentSettingsReason = {
  Invalid: 'SETTINGS_INVALID_REQUEST', Unavailable: 'SETTINGS_UNAVAILABLE', Agent: 'AGENT_UNAVAILABLE',
  LocalAction: 'LOCAL_ACTION_REQUIRED', TooLarge: 'SETTINGS_CONTENT_TOO_LARGE', Conflict: 'SETTINGS_REVISION_CONFLICT',
  Pending: 'SETTINGS_OPERATION_PENDING', OperationConflict: 'SETTINGS_OPERATION_ID_CONFLICT',
  DirectEdit: 'DIRECT_EDIT_NOT_ALLOWED', Conversation: 'CONVERSATION_SOURCE_INVALID', Expired: 'SETTINGS_OPERATION_EXPIRED',
  Cleanup: 'LOCAL_CLEANUP_REQUIRED', Collaborator: 'COLLABORATOR_UNAVAILABLE',
} as const;
export class AgentSettingsError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'AgentSettingsError'; }
}

/** Host-created context. assertAccess must compare it with current authenticated/local state. */
export interface AgentSettingsContext {
  owner: { userId: string; scopeKey: string };
  dataSpaceId: string; dataGeneration: string; deviceId: string; agentId: string; accountEpoch: string;
  source: typeof AgentSettingsSource[keyof typeof AgentSettingsSource];
  bindingId?: string; bindingVersion?: string;
  commandId?: string; runId?: string; toolCallId?: string;
}
export interface AgentSettingsAgent {
  id: string; enabled: boolean; model: string; thinkingLevel: string; identity: string;
  subagentAllowAgentIds: string[]; updatedAt?: number;
}
export interface AgentSettingsModelSelection { modelRef: string; modelVersion: string; thinkingLevel: string | null }
export interface AgentSettingsModelValue {
  modelRef: string | null; modelVersion: string | null; thinkingLevel: string | null; inherited: boolean;
  selectionState: 'available' | 'unavailable' | 'unconfigured'; unavailableReason: string | null;
}
export interface AgentSettingsCollaborator { agentId: string; agentVersion: string; name: string; icon: string | null }
export interface AgentSettingsSnapshot {
  revision: string; value: Record<string, unknown>; readAt: string;
  documentState?: 'missing' | 'empty' | 'present'; sourceUpdatedAt?: string | null;
}
export interface AgentSettingsProposal {
  operationId: string; section: AgentSettingsSection; expectedRevision: string; value: unknown;
  changeKind?: 'append' | 'replace_selection' | 'replace_all' | 'clear';
  /** UTF-16 offsets in the exact current text, checked together with expectedText. */
  selection?: { start: number; end: number; expectedText: string };
}
export interface AgentSettingsPrepared {
  operationId: string; section: AgentSettingsSection; revision: string; proposedDigest: string;
  status: typeof AgentSettingsPhase.Prepared | typeof AgentSettingsPhase.NoChange;
}
export interface AgentSettingsReceipt {
  operationId: string; section: AgentSettingsSection;
  status: typeof AgentSettingsPhase.Applied | typeof AgentSettingsPhase.Rejected | typeof AgentSettingsPhase.Reconciling;
  revision?: string; effect?: 'future_safe_boundary'; reason?: string;
}
export interface AgentSettingsPermit { permitId: string; startBefore: number }
export interface AgentSettingsWriteLease { assertCurrent(): void; release(): void }
/** Implementation must durably and atomically protect values at rest; errors must fail closed. */
export interface AgentSettingsPersistence { get<T>(key: string): T | null; set(key: string, value: unknown): void }
export interface AgentSettingsDependencies {
  stateDir: string; store: AgentSettingsPersistence;
  assertAccess(context: AgentSettingsContext, section: AgentSettingsSection, action: AgentSettingsAction): void;
  /** Original authenticated owner/data/device only; permits receipt lookup after binding revocation. */
  assertRecoveryAccess?(context: AgentSettingsContext): void;
  /** Internal source verification only; checks historical scope and current Agent ownership, never returns text. */
  assertRecoverySourceAccess?(context: AgentSettingsContext): void;
  getAgent(context: AgentSettingsContext): AgentSettingsAgent | null;
  updateAgent(context: AgentSettingsContext, patch: Partial<Pick<AgentSettingsAgent, 'model' | 'thinkingLevel' | 'identity' | 'subagentAllowAgentIds'>>): void;
  readModel(context: AgentSettingsContext, agent: AgentSettingsAgent): AgentSettingsModelValue | Promise<AgentSettingsModelValue>;
  resolveModel(context: AgentSettingsContext, selection: AgentSettingsModelSelection): { model: string; thinkingLevel: string } | Promise<{ model: string; thinkingLevel: string }>;
  listCollaborators(context: AgentSettingsContext): AgentSettingsCollaborator[] | Promise<AgentSettingsCollaborator[]>;
  /** Must cover local UI, runtime tools and background writers; absence never grants writes. */
  acquireWriteLease(context: AgentSettingsContext, section: AgentSettingsSection): Promise<AgentSettingsWriteLease>;
  /** Recovery confirmation only: no source-run liveness requirement and no new write permission. */
  acquireRecoveryLease?(context: AgentSettingsContext, section: AgentSettingsSection): Promise<AgentSettingsWriteLease>;
  /** Resolve only after the relevant runtime/config projection has been confirmed. */
  confirmApplied(context: AgentSettingsContext, section: AgentSettingsSection): Promise<void>;
  /** Trusted run/intent/approval proof belongs to the host, never to model-provided parameters. */
  authorizeConversation?(context: AgentSettingsContext, proposal: AgentSettingsProposal, proposedDigest: string): Promise<void>;
  now?(): number;
}
