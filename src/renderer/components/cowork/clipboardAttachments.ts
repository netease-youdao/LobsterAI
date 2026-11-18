import {
  createCopiedMessageImageFile,
  extractCopiedMessageImages,
} from '../../services/messageClipboard';

export const getClipboardAttachmentFiles = (
  clipboardData: Pick<DataTransfer, 'files'> | null,
): File[] => Array.from(clipboardData?.files ?? []);

/** Images carried by a message copied with its copy button; empty for any other clipboard content. */
export const getCopiedMessageImageFiles = (
  clipboardData: Pick<DataTransfer, 'getData'> | null,
): File[] => {
  const html = clipboardData?.getData('text/html') ?? '';
  return extractCopiedMessageImages(html).map(createCopiedMessageImageFile);
};
