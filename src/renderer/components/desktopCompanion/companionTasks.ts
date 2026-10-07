import { AgentId } from '../../../shared/agent/constants';
import type { DesktopCompanionAttachment } from '../../../shared/desktopCompanion/constants';
import { type CompanionFileKind, companionFileKindFromMime } from '../../../shared/desktopCompanion/fileKinds';
import { prepareCoworkPromptPayload } from '../../services/coworkPromptPayload';
import { i18nService } from '../../services/i18n';

const IMAGE_PATTERN = /\.(png|jpe?g|webp|gif|bmp|heic)$/i;

export const fileName = (filePath: string) => filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;

export function parentDirectory(filePath: string): string {
  const separator = filePath.includes('\\') && !filePath.includes('/') ? '\\' : '/';
  const index = filePath.lastIndexOf(separator);
  if (index <= 0) return separator === '/' ? '/' : filePath;
  // Keep a drive root such as C:\ intact.
  return /^[A-Za-z]:$/.test(filePath.slice(0, index)) ? filePath.slice(0, index + 1) : filePath.slice(0, index);
}

/** File kinds of an in-flight drag, from MIME types (names are hidden until the drop). */
export function fileKindsFromDataTransfer(transfer: DataTransfer | null): CompanionFileKind[] {
  if (!transfer) return [];
  return [...new Set(Array.from(transfer.items ?? [])
    .filter(item => item.kind === 'file')
    .map(item => companionFileKindFromMime(item.type)))];
}

export function hasFiles(transfer: DataTransfer | null): boolean {
  return !!transfer && Array.from(transfer.types ?? []).includes('Files');
}

/** Turns dropped files into attachments; files without a local path are skipped. */
export async function filesToAttachments(files: File[]): Promise<DesktopCompanionAttachment[]> {
  const attachments: DesktopCompanionAttachment[] = [];
  for (const file of files.slice(0, 20)) {
    const filePath = window.electron.dialog.getPathForFile?.(file);
    if (!filePath) continue;
    let isDirectory = false;
    try {
      const stat = await window.electron.dialog.statFile(filePath);
      if (!stat.success) continue;
      isDirectory = stat.isDirectory === true;
    } catch {
      continue;
    }
    attachments.push({ path: filePath, name: file.name || fileName(filePath), isDirectory, isImage: !isDirectory && IMAGE_PATTERN.test(filePath) });
  }
  return attachments;
}

async function defaultWorkingDirectory(): Promise<string> {
  try {
    const result = await window.electron.cowork.getConfig();
    return result.success ? result.config?.workingDirectory ?? '' : '';
  } catch {
    return '';
  }
}

export interface CompanionTaskRequest {
  prompt: string;
  attachments: DesktopCompanionAttachment[];
  workingDirectory?: string;
}

/**
 * Starts a Cowork task through the existing session API. The working folder is
 * the explicit one, else the app default, else the folder of the first file.
 */
export async function startCompanionTask(request: CompanionTaskRequest): Promise<{ sessionId: string } | { error: string }> {
  const t = (key: string) => i18nService.t(key);
  const firstFile = request.attachments[0]?.path;
  const cwd = request.workingDirectory || await defaultWorkingDirectory() || (firstFile ? parentDirectory(firstFile) : '');
  if (!cwd) return { error: t('desktopCompanionRequestFailed') };
  const prepared = await prepareCoworkPromptPayload({
    basePrompt: request.prompt.trim(),
    attachments: request.attachments,
    selectedTextSnippets: [],
    // Files stay local references; the agent reads them with its own tools.
    modelSupportsImage: false,
    fileLabel: t('file'),
    folderLabel: t('folder'),
  });
  if (!prepared.success) return { error: t('desktopCompanionImageFailed') };
  const result = await window.electron.cowork.startSession({
    prompt: prepared.payload.finalPrompt,
    cwd,
    agentId: AgentId.Main,
    imageAttachments: prepared.payload.imageAttachments,
    mediaReferences: prepared.payload.mediaReferences,
  });
  if (!result.success || !result.session) return { error: result.error || t('desktopCompanionRequestFailed') };
  return { sessionId: result.session.id };
}
