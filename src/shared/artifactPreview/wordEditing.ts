import type { WordAgentRequest, WordAgentResponse } from './wordAgent';
import type { WordDocumentFontDecl, WordFontResolveResult } from './wordFonts';

export const WordFileIpc = {
  Open: 'artifact:word:open',
  Read: 'artifact:word:read',
  Checkpoint: 'artifact:word:checkpoint',
  Save: 'artifact:word:save',
  DiscardDraft: 'artifact:word:discard-draft',
  Release: 'artifact:word:release',
  Changed: 'artifact:word:changed',
  SetUnsafeEdits: 'artifact:word:set-unsafe-edits',
  ResolveFonts: 'artifact:word:resolve-fonts',
  ReadFont: 'artifact:word:read-font',
} as const;

/** Content the open core preserves but does not manage; such files open read only. */
export const WordReadOnlyReason = {
  Comments: 'comments',
  Revisions: 'revisions',
  Protection: 'protection',
  Embedded: 'embedded',
  Signature: 'signature',
  Macros: 'macros',
  ExternalContent: 'external-content',
} as const;
export type WordReadOnlyReason = typeof WordReadOnlyReason[keyof typeof WordReadOnlyReason];

/** What admission learned about a package besides its validity. */
export interface WordPackageInfo {
  readOnly: WordReadOnlyReason[];
  fonts: WordDocumentFontDecl[];
}

export const WordFileError = {
  InvalidFile: 'invalid-file',
  TooLarge: 'too-large',
  Unsupported: 'unsupported',
  Conflict: 'conflict',
  Forbidden: 'forbidden',
  Io: 'io',
} as const;
export type WordFileError = typeof WordFileError[keyof typeof WordFileError];

export const WORD_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const WORD_MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
export const WORD_MAX_PART_BYTES = 25 * 1024 * 1024;
export const WORD_MAX_PARTS = 4096;

export interface WordFileSnapshot extends WordPackageInfo {
  filePath: string;
  bytes: Uint8Array;
  version: string;
}

export interface WordCheckpoint {
  bytes: Uint8Array;
  baseVersion: string;
  revision: number;
}

export interface WordOpenResult extends WordFileSnapshot {
  sessionId: string;
  recovery?: WordCheckpoint;
}

export type WordResult<T> = { success: true; value: T } | {
  success: false;
  code: WordFileError;
};

export interface WordWriteRequest extends WordCheckpoint {
  sessionId: string;
}

/** File access is scoped to an opaque handle owned by the main renderer. */
export interface WordFileApi {
  open: (filePath: string) => Promise<WordResult<WordOpenResult>>;
  read: (sessionId: string) => Promise<WordResult<WordFileSnapshot>>;
  checkpoint: (request: WordWriteRequest) => Promise<WordResult<null>>;
  save: (request: WordWriteRequest) => Promise<WordResult<{ version: string; originalCopyPath?: string }>>;
  discardDraft: (sessionId: string) => Promise<WordResult<null>>;
  release: (sessionId: string) => Promise<void>;
}

/** Installed fonts, looked up by family name; bytes are fetched one face at a time. */
export interface WordFontApi {
  resolveFonts: (families: string[]) => Promise<WordResult<WordFontResolveResult>>;
  readFont: (faceId: string) => Promise<WordResult<Uint8Array>>;
}

/** Agent tool calls routed to the live editor, answered once per request. */
export interface WordAgentChannel {
  onAgentRequest: (listener: (request: WordAgentRequest) => void) => () => void;
  respondAgent: (response: WordAgentResponse) => void;
}

export interface WordFileBridge extends WordFileApi, WordFontApi, WordAgentChannel {
  setHasUnsafeEdits: (unsafe: boolean) => void;
  onChanged: (listener: (sessionId: string) => void) => () => void;
}
