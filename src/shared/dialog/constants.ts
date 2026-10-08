export const DialogIpc = {
  StatFile: 'dialog:statFile',
  ReadTextFile: 'dialog:readTextFile',
  SaveFileCopy: 'dialog:saveFileCopy',
  GenerateThumbnail: 'dialog:generateThumbnail',
  CancelThumbnail: 'dialog:cancelThumbnail',
} as const;

export type DialogIpc = typeof DialogIpc[keyof typeof DialogIpc];
