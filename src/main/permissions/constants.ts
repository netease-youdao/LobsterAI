export const RendererPermission = {
  ClipboardRead: 'clipboard-read',
  ClipboardWrite: 'clipboard-sanitized-write',
  Media: 'media',
} as const;

export const RendererMediaType = {
  Audio: 'audio',
  Video: 'video',
} as const;

export type RendererMediaType = typeof RendererMediaType[keyof typeof RendererMediaType];
