export const MarkdownFileIpc = {
  Read: 'artifact:markdown:read',
  Save: 'artifact:markdown:save',
  SetUnsafeEdits: 'artifact:markdown:setUnsafeEdits',
} as const;

export const MarkdownFileError = {
  InvalidFile: 'invalid_file',
  TooLarge: 'too_large',
  InvalidEncoding: 'invalid_encoding',
  Conflict: 'conflict',
  Io: 'io',
} as const;
export type MarkdownFileError = typeof MarkdownFileError[keyof typeof MarkdownFileError];

export const MAX_EDITABLE_MARKDOWN_BYTES = 2 * 1024 * 1024;

export interface MarkdownFileSnapshot {
  filePath: string;
  content: string;
  version: string;
}

export type MarkdownFileResult =
  | { success: true; file: MarkdownFileSnapshot }
  | { success: false; code: MarkdownFileError; error: string };

export interface SaveMarkdownFileRequest {
  filePath: string;
  content: string;
  expectedVersion: string;
}

export interface MarkdownFileApi {
  read: (filePath: string) => Promise<MarkdownFileResult>;
  save: (request: SaveMarkdownFileRequest) => Promise<MarkdownFileResult>;
}

export interface MarkdownFileBridge extends MarkdownFileApi {
  setHasUnsafeEdits: (hasUnsafeEdits: boolean) => void;
}
