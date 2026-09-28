/**
 * Contracts shared by LobsterAI's in-place Office editors. The Word editor predates these and
 * keeps its own equivalents in wordEditing.ts / wordAgent.ts; new formats build on this module.
 */

/** Same values as WordFileError, so both editors report failures alike. */
export const OfficeFileError = {
  InvalidFile: 'invalid-file',
  TooLarge: 'too-large',
  Unsupported: 'unsupported',
  Conflict: 'conflict',
  Forbidden: 'forbidden',
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

/** Limits enforced on packages before any part is parsed. */
export interface OfficePackageLimits {
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxPartBytes: number;
  maxParts: number;
}
