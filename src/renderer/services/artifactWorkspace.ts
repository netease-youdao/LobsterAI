import type {
  BlankDocumentKind,
  CreateBlankDocumentResponse,
  ProbeGitWorkspaceResponse,
  RenameArtifactFileResponse,
} from '../../shared/artifactPreview/blankDocument';
import { ReviewScope } from '../../shared/artifactPreview/reviewScopes';
import type { ResolvedArtifactOutput } from '../../shared/artifactPreview/workspace';
import type { LocalArtifactItem } from '../../shared/library/types';
import type { LocalWebService } from '../../shared/localWebServices/constants';

export type { BlankDocumentKind, CreateBlankDocumentResponse, ProbeGitWorkspaceResponse };

const EMPTY_GIT_PROBE: ProbeGitWorkspaceResponse = {
  isGitRepository: false,
  changedFileCount: 0,
  branch: null,
};

export async function createBlankWorkspaceDocument(options: {
  sessionId?: string;
  cwd?: string;
  kind: BlankDocumentKind;
  baseName?: string;
}): Promise<CreateBlankDocumentResponse> {
  const api = window.electron?.artifact?.createBlankDocument;
  if (!api) {
    return { success: false, error: 'Blank document API is unavailable' };
  }
  return api(options);
}

export async function probeWorkspaceGitStatus(options: {
  sessionId?: string;
  cwd?: string;
}): Promise<ProbeGitWorkspaceResponse> {
  const api = window.electron?.artifact?.probeGitWorkspace;
  if (!api) return EMPTY_GIT_PROBE;
  try {
    return await api(options);
  } catch {
    return EMPTY_GIT_PROBE;
  }
}

export async function readWorkspaceChangesReview(
  sessionId: string,
): Promise<ResolvedArtifactOutput | null> {
  const api = window.electron?.workspaceReview?.read;
  if (!api) return null;
  return api({ sessionId, scope: ReviewScope.Repository });
}

export async function searchLocalLibraryFiles(
  keyword: string,
  pageSize = 6,
): Promise<LocalArtifactItem[]> {
  const api = window.electron?.library?.listLocal;
  if (!api) return [];
  try {
    const result = await api({ keyword: keyword.trim() || undefined, pageSize });
    return result?.success ? result.data.list : [];
  } catch {
    return [];
  }
}

export async function listRunningLocalWebServices(
  preferredPorts?: number[],
): Promise<LocalWebService[]> {
  const api = window.electron?.artifact?.listLocalWebServices;
  if (!api) return [];
  try {
    return await api(preferredPorts?.length ? { preferredPorts } : undefined);
  } catch {
    return [];
  }
}

export async function pickLocalFileForPreview(title?: string): Promise<string | null> {
  const api = window.electron?.dialog?.selectFile;
  if (!api) return null;
  const result = await api({ title });
  return result?.success && result.path ? result.path : null;
}

export async function openWorkspaceDirectoryInSystem(directoryPath: string): Promise<void> {
  if (!directoryPath.trim()) return;
  await window.electron?.shell?.openPath(directoryPath);
}

export async function renameLocalArtifactFile(
  filePath: string,
  newBaseName: string,
): Promise<RenameArtifactFileResponse> {
  const api = window.electron?.artifact?.renameFile;
  if (!api) {
    return { success: false, error: 'Rename file API is unavailable' };
  }
  return api({ filePath, newBaseName });
}
