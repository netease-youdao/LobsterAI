import { ImPeerKind, parseImConversationId } from '../platform/conversationId';

const FeishuRouteParam = {
  ReplyTo: '__feishu_reply_to',
  Thread: '__feishu_thread_id',
} as const;
const THREAD_SEGMENT = 'thread';

export interface FeishuReplyRoute {
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
}

export function buildFeishuTopicConversationId(chatId: string, threadId: string): string {
  return `${ImPeerKind.Group}:${chatId}:${THREAD_SEGMENT}:${threadId}`;
}

export function parseFeishuReplyRoute(value: string): FeishuReplyRoute | null {
  const [target, fragment] = value.trim().split('#', 2);
  const peer = parseImConversationId(target).peerId.replace(/^feishu:/, '').replace(/^chat:/, '');
  const params = new URLSearchParams(fragment);
  const [chatId, threadId] = peer.split(`:${THREAD_SEGMENT}:`, 2);
  const topicId = params.get(FeishuRouteParam.Thread)?.trim() || threadId?.trim();
  // In older topic groups the thread key could be the root message ID.
  const replyToMessageId = params.get(FeishuRouteParam.ReplyTo)?.trim()
    || (topicId?.startsWith('om_') ? topicId : undefined);
  if (!chatId || (!topicId && !replyToMessageId)) return null;
  return { chatId, ...(topicId ? { threadId: topicId } : {}), ...(replyToMessageId ? { replyToMessageId } : {}) };
}

export function formatFeishuReplyRoute(route: FeishuReplyRoute): string {
  const params = new URLSearchParams();
  if (route.replyToMessageId) params.set(FeishuRouteParam.ReplyTo, route.replyToMessageId);
  if (route.threadId) params.set(FeishuRouteParam.Thread, route.threadId);
  return `${route.chatId}#${params.toString()}`;
}
