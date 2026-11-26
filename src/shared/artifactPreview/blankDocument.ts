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
  ListDirectory: 'artifact:listWorkspaceDirectory',
} as const;

export type ArtifactWorkspaceIpc = typeof ArtifactWorkspaceIpc[keyof typeof ArtifactWorkspaceIpc];

export const WorkspaceDirectoryEntryKind = {
  Directory: 'directory',
  File: 'file',
} as const;

export type WorkspaceDirectoryEntryKind =
  typeof WorkspaceDirectoryEntryKind[keyof typeof WorkspaceDirectoryEntryKind];

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  kind: WorkspaceDirectoryEntryKind;
}

export interface ListWorkspaceDirectoryRequest {
  sessionId?: string;
  cwd?: string;
  targetPath?: string;
  includeHidden?: boolean;
}

export type ListWorkspaceDirectoryResponse =
  | {
      success: true;
      rootPath: string;
      directoryPath: string;
      entries: WorkspaceDirectoryEntry[];
      truncated: boolean;
      totalCount: number;
    }
  | {
      success: false;
      rootPath?: string;
      directoryPath?: string;
      error: string;
    };

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
