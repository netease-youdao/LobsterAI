/** Version two transports references only. Provider configuration and paths stay local. */
export const RemoteInputCapability = { Schema: 'input_schema_v2', Models: 'model_selection_v1', Attachments: 'input_attachments_v1' } as const;
export const RemoteInputMode = { Selected: 'selected', Agent: 'inherit_agent', Session: 'keep_session' } as const;
export const RemoteInputIntent = { File: 'file', Image: 'image' } as const;
export const RemoteInputStatus = { Ready: 'ready', Failed: 'failed', Invalidated: 'invalidated' } as const;
export const RemoteInputReason = {
  Invalid: 'INPUT_UNSUPPORTED', ModelUnavailable: 'MODEL_UNAVAILABLE', ModelChanged: 'MODEL_VERSION_CONFLICT',
  AgentUnavailable: 'AGENT_UNAVAILABLE', AgentChanged: 'AGENT_VERSION_CONFLICT', Workspace: 'WORKSPACE_UNAVAILABLE',
  Stale: 'INPUT_PREPARATION_INVALIDATED', Asset: 'ASSET_NOT_READY', Account: 'ACCESS_DENIED',
  Busy: 'SESSION_BUSY', Version: 'INPUT_VERSION_CONFLICT', Expired: 'COMMAND_EXPIRED',
} as const;
export const RemoteModelUnavailableReason = { PermissionDenied: 'PERMISSION_DENIED', Unsupported: 'UNSUPPORTED' } as const;
export interface RemoteModelItem {
  modelRef: string; version: string; source: 'subscription' | 'custom'; displayName: string; providerLabel: string;
  available: boolean; unavailableReason: string | null;
  inputCapabilities: { text: boolean; image: boolean; toolCalling: boolean };
  thinking: { options: string[]; default?: string | null };
}
export interface RemoteInputAsset {
  assetId: string; version: string; intent: 'file' | 'image'; sha256: string; sizeBytes: string; mimeType: string; fileName: string;
}
export interface RemoteResolvedInput {
  text: string; agentId: string; expectedAgentVersion: string; workspaceId: string | null;
  model: { modelRef: string; version: string }; options: { thinkingLevel?: string }; attachments: RemoteInputAsset[];
}
export interface RemoteInputRequest {
  preparationId: string; inputSchemaVersion: 2; purpose: 'create_session' | 'send_message'; draftId: string;
  sessionId?: string; expectedControlVersion?: string; expectedInputVersion?: string;
  input: {
    text?: string; agent?: { agentId: string; expectedVersion: string };
    model: { mode: 'selected' | 'inherit_agent' | 'keep_session'; modelRef?: string; expectedVersion?: string };
    options?: { thinkingLevel?: string };
    attachments?: Array<{ kind: 'uploaded_asset'; assetId: string; version: string; intent: 'file' | 'image' }>;
  };
}
export interface RemotePreparationClaim {
  preparationId: string; request: RemoteInputRequest; statusVersion: string; claimId: string; claimToken: string;
  claimUntil: string; grantVersion?: string; expiresAt?: string; attachments?: RemoteInputAsset[];
}

/** Only schema version 2 carries a durable dispatch boundary. Legacy fences remain unknown. */
export const RemoteInputOperationPhase = {
  Prepared: 'prepared', Dispatched: 'dispatched', Confirmed: 'confirmed',
  KnownNotApplied: 'known_not_applied', Unknown: 'unknown',
} as const;

/** Recovery is a server capability, not a desktop execution capability. */
export const RemoteInputRecovery = { Capability: 'isolated_input_recovery_v1', Unavailable: 'stored_data_unavailable',
  Limit: 20, RetryMs: 30_000, DiagnosticLimit: 200 } as const;
export interface RemoteInputRecoveryReceipt {
  preparationId: string; status: string; inputDigest?: string; readyExpiresAt?: string; boundCommandId?: string | null;
  request?: RemoteInputRequest;
  targetSummary?: { deviceId?: string; sessionId?: string | null; resolvedInput?: RemoteResolvedInput | null };
}
export interface RemoteInputRecoveryPage {
  items: RemoteInputRecoveryReceipt[];
  unresolvedItems: Array<{ preparationId: string; sessionId?: string; diagnostic: { kind: string; retryAfterMs: number } }>;
  nextCursor: string | null; scanComplete: boolean;
}
