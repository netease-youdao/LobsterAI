/**
 * File and agent contracts shared by LobsterAI's in-place Office editors. Each format adds its
 * package facts (read-only reasons and the like) through `OfficePackageInfo`.
 */

export const OfficeFileError = {
  InvalidFile: 'invalid-file',
  TooLarge: 'too-large',
  Unsupported: 'unsupported',
  Conflict: 'conflict',
  Forbidden: 'forbidden',
  /** Another program holds the file open and Windows refuses to write it, as with Excel or WPS. */
  InUse: 'in-use',
  Io: 'io',
} as const;
export type OfficeFileError = typeof OfficeFileError[keyof typeof OfficeFileError];

export type OfficeResult<T> = { success: true; value: T } | { success: false; code: OfficeFileError };

/** What package admission learned; any read-only reason keeps the document in viewing mode. */
export interface OfficePackageInfo<TReason extends string = string> {
  readOnly: TReason[];
}

export type OfficeFileSnapshot<TInfo extends OfficePackageInfo> = TInfo & {
  filePath: string;
  bytes: Uint8Array;
  /** SHA-256 of the bytes on disk. */
  version: string;
  /** Another program, such as Excel or WPS, holds the file open, so saving waits (Windows). */
  inUse?: boolean;
};

export interface OfficeCheckpoint {
  bytes: Uint8Array;
  baseVersion: string;
  revision: number;
}

export type OfficeOpenResult<TInfo extends OfficePackageInfo> = OfficeFileSnapshot<TInfo> & {
  sessionId: string;
  recovery?: OfficeCheckpoint;
};

export interface OfficeWriteRequest extends OfficeCheckpoint {
  sessionId: string;
}

export interface OfficeSaveReceipt {
  version: string;
  originalCopyPath?: string;
}

/** File access is scoped to an opaque handle owned by the main window's renderer. */
export interface OfficeFileApi<TInfo extends OfficePackageInfo> {
  open: (filePath: string) => Promise<OfficeResult<OfficeOpenResult<TInfo>>>;
  read: (sessionId: string) => Promise<OfficeResult<OfficeFileSnapshot<TInfo>>>;
  checkpoint: (request: OfficeWriteRequest) => Promise<OfficeResult<null>>;
  save: (request: OfficeWriteRequest) => Promise<OfficeResult<OfficeSaveReceipt>>;
  discardDraft: (sessionId: string) => Promise<OfficeResult<null>>;
  release: (sessionId: string) => Promise<void>;
}

export interface OfficeAgentRequest {
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface OfficeAgentToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface OfficeAgentResponse {
  requestId: string;
  result: OfficeAgentToolResult;
}

/** Everything the renderer reaches of one format: its files, exit protection and agent calls. */
export interface OfficeFileBridge<TInfo extends OfficePackageInfo> extends OfficeFileApi<TInfo> {
  setHasUnsafeEdits: (unsafe: boolean) => void;
  onChanged: (listener: (sessionId: string) => void) => () => void;
  onAgentRequest: (listener: (request: OfficeAgentRequest) => void) => () => void;
  respondAgent: (response: OfficeAgentResponse) => void;
}

/** IPC channel names of one format's file bridge. */
export interface OfficeFileChannels {
  Open: string;
  Read: string;
  Checkpoint: string;
  Save: string;
  DiscardDraft: string;
  Release: string;
  Changed: string;
  SetUnsafeEdits: string;
  AgentRequest: string;
  AgentRespond: string;
}

/**
 * The file bridge channels of the editor with the given id, `artifact:<id>:<action>`. They are
 * part of the preload contract, so an editor's id never changes once it ships.
 */
export function officeFileChannels<TId extends string>(id: TId) {
  return {
    Open: `artifact:${id}:open`,
    Read: `artifact:${id}:read`,
    Checkpoint: `artifact:${id}:checkpoint`,
    Save: `artifact:${id}:save`,
    DiscardDraft: `artifact:${id}:discard-draft`,
    Release: `artifact:${id}:release`,
    Changed: `artifact:${id}:changed`,
    SetUnsafeEdits: `artifact:${id}:set-unsafe-edits`,
    AgentRequest: `artifact:${id}:agent-request`,
    AgentRespond: `artifact:${id}:agent-respond`,
  } as const satisfies OfficeFileChannels;
}

/** Limits enforced on packages before any part is parsed. */
export interface OfficePackageLimits {
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxPartBytes: number;
  maxParts: number;
}
