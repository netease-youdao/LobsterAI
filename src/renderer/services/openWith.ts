import { isImagePath } from '../components/cowork/attachmentPaths';
import type { DraftAttachment } from '../store/slices/coworkSlice';
import { getLastPathSegment } from '../utils/path';

export interface OpenWithPathStat {
  success: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
}

/**
 * Turns the paths macOS asked LobsterAI to open into prompt attachments,
 * skipping items that are gone by now. Images carry no data URL: the
 * attachment card loads the thumbnail from the path, and sending reads the
 * pixels only when the selected model accepts images.
 */
export async function resolveOpenWithAttachments(
  paths: string[],
  statPath: (filePath: string) => Promise<OpenWithPathStat>,
): Promise<DraftAttachment[]> {
  const stats = await Promise.all(paths.map(filePath => statPath(filePath).catch(() => null)));
  const attachments: DraftAttachment[] = [];
  paths.forEach((filePath, index) => {
    const stat = stats[index];
    if (!stat?.success) return;
    const name = getLastPathSegment(filePath) || filePath;
    if (stat.isDirectory) {
      attachments.push({ path: filePath, name, isDirectory: true });
    } else if (stat.isFile) {
      attachments.push(isImagePath(filePath) ? { path: filePath, name, isImage: true } : { path: filePath, name });
    }
  });
  return attachments;
}
