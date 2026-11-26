/** Explicit desktop picker selections; never infer upload permission from text paths. */
export interface CoworkLocalInput {
  text: string;
  attachments: Array<{ path: string; name: string; intent: 'file' | 'image' }>;
}
