export const BookmarkMessageType = {
  User: 'user',
  Assistant: 'assistant',
} as const;
export type BookmarkMessageType = (typeof BookmarkMessageType)[keyof typeof BookmarkMessageType];

export const BookmarkIpcChannel = {
  Add: 'bookmark:add',
  Remove: 'bookmark:remove',
  List: 'bookmark:list',
  IsBookmarked: 'bookmark:isBookmarked',
} as const;
