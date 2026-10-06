export const getClipboardAttachmentFiles = (
  clipboardData: Pick<DataTransfer, 'files'> | null,
): File[] => Array.from(clipboardData?.files ?? []);
