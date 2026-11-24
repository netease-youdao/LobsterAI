import path from 'node:path';

import { ipcMain } from 'electron';

import {
  ArtifactWorkspaceIpc,
  BlankDocumentKind,
  type CreateBlankDocumentRequest,
  type CreateBlankDocumentResponse,
  type ProbeGitWorkspaceRequest,
  type ProbeGitWorkspaceResponse,
  type RenameArtifactFileRequest,
  type RenameArtifactFileResponse,
} from '../../../shared/artifactPreview/blankDocument';
import { createBlankDocumentInDirectory } from '../../office/blankDocuments';
import { EMPTY_GIT_PROBE, probeGitWorkspaceDirectory } from './gitProbe';
import { renameLocalFileInPlace } from './renameFile';

const VALID_KINDS = new Set<string>(Object.values(BlankDocumentKind));

export interface ArtifactWorkspaceHandlerDeps {
  getSessionCwd: (sessionId: string) => string | undefined;
  getDefaultCwd: () => string | undefined;
}

function resolveTargetDirectory(
  deps: ArtifactWorkspaceHandlerDeps,
  sessionId?: string,
  cwd?: string,
): string | undefined {
  const fromSession = typeof sessionId === 'string' && sessionId.trim()
    ? deps.getSessionCwd(sessionId.trim())
    : undefined;
  const candidate = fromSession?.trim() || (typeof cwd === 'string' ? cwd.trim() : '') || deps.getDefaultCwd()?.trim();
  return candidate && path.isAbsolute(candidate) ? candidate : undefined;
}

export function registerArtifactWorkspaceHandlers(deps: ArtifactWorkspaceHandlerDeps): void {
  ipcMain.handle(
    ArtifactWorkspaceIpc.CreateBlankDocument,
    async (_event, input: CreateBlankDocumentRequest): Promise<CreateBlankDocumentResponse> => {
      try {
        if (!input || !VALID_KINDS.has(input.kind)) {
          return { success: false, error: 'Unsupported blank document kind' };
        }
        const directory = resolveTargetDirectory(deps, input.sessionId, input.cwd);
        if (!directory) {
          return { success: false, error: 'No valid working directory available' };
        }
        const created = await createBlankDocumentInDirectory(directory, input.kind, input.baseName);
        return { success: true, filePath: created.filePath, fileName: created.fileName };
      } catch (error) {
        console.error('[ArtifactWorkspace] Failed to create blank document:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create blank document',
        };
      }
    },
  );

  ipcMain.handle(
    ArtifactWorkspaceIpc.ProbeGitWorkspace,
    async (_event, input: ProbeGitWorkspaceRequest): Promise<ProbeGitWorkspaceResponse> => {
      const directory = resolveTargetDirectory(deps, input?.sessionId, input?.cwd);
      if (!directory) return EMPTY_GIT_PROBE;
      return probeGitWorkspaceDirectory(directory);
    },
  );

  ipcMain.handle(
    ArtifactWorkspaceIpc.RenameFile,
    async (_event, input: RenameArtifactFileRequest): Promise<RenameArtifactFileResponse> => {
      if (!input || typeof input.filePath !== 'string' || typeof input.newBaseName !== 'string') {
        return { success: false, error: 'Invalid rename request' };
      }
      return renameLocalFileInPlace(input.filePath, input.newBaseName);
    },
  );
}
