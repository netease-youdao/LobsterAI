/** Telegram forum peers in OpenClaw session keys and DSH delivery targets. */
export function parseTelegramGroupTopic(peerId: string): { chatId: string; threadId: string } | null {
  const match = /^(-\d+):topic:(\d+)$/.exec(peerId);
  return match ? { chatId: match[1], threadId: match[2] } : null;
}
