export const ClipboardIpc = {
  WriteText: 'clipboard:writeText',
  WriteTextAndHtml: 'clipboard:writeTextAndHtml',
  WriteImageFromFile: 'clipboard:writeImageFromFile',
  WriteImageFromDataUrl: 'clipboard:writeImageFromDataUrl',
} as const;

export type ClipboardIpc = typeof ClipboardIpc[keyof typeof ClipboardIpc];
