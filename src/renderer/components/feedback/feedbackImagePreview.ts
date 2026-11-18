const FEEDBACK_PREVIEW_PROTOCOL = 'blob:';

export function getFeedbackImagePreviewUrl(url: string): string | undefined {
  if (!url.startsWith(FEEDBACK_PREVIEW_PROTOCOL) || /["'&<>\s\p{Cc}]/u.test(url)) {
    return undefined;
  }
  return url;
}
