export const BlankDocumentKind = {
  Word: 'word',
  Slides: 'slides',
  Sheet: 'sheet',
  Markdown: 'markdown',
} as const;

export type BlankDocumentKind = typeof BlankDocumentKind[keyof typeof BlankDocumentKind];

export const ArtifactWorkspaceIpc = {
  CreateBlankDocument: 'artifact:createBlankDocument',
  ProbeGitWorkspace: 'artifact:probeGitWorkspace',
  RenameFile: 'artifact:renameFile',
} as const;

export type ArtifactWorkspaceIpc = typeof ArtifactWorkspaceIpc[keyof typeof ArtifactWorkspaceIpc];

export interface CreateBlankDocumentRequest {
  sessionId?: string;
  cwd?: string;
  kind: BlankDocumentKind;
  baseName?: string;
}

export type CreateBlankDocumentResponse =
  | { success: true; filePath: string; fileName: string }
  | { success: false; error: string };

export interface ProbeGitWorkspaceRequest {
  sessionId?: string;
  cwd?: string;
}

export interface ProbeGitWorkspaceResponse {
  isGitRepository: boolean;
  changedFileCount: number;
  branch: string | null;
}

export interface RenameArtifactFileRequest {
  filePath: string;
  newBaseName: string;
}

export type RenameArtifactFileResponse =
  | { success: true; filePath: string; fileName: string }
  | { success: false; error: string };
