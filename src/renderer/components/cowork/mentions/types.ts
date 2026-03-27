export type MentionKind = 'attachment';

export interface MentionItem {
  mentionId: string;
  kind: MentionKind;
  label: string;
  mentionToken: string;
  searchText: string[];
  isImage?: boolean;
  dataUrl?: string;
}

export type AttachmentMentionSourceKind = 'clipboard_image' | 'file_image' | 'file';

export interface AttachmentMentionItem extends MentionItem {
  kind: 'attachment';
  path: string;
  name: string;
  sourceKind: AttachmentMentionSourceKind;
}
