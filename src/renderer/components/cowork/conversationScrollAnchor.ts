export const ConversationScrollAnchorAttribute = {
  Message: 'data-cowork-search-message-id',
  Turn: 'data-conversation-turn-last-message-id',
} as const;

type AnchorAttribute = typeof ConversationScrollAnchorAttribute[keyof typeof ConversationScrollAnchorAttribute];

export interface ConversationScrollAnchor {
  candidates: Array<{
    attribute: AnchorAttribute;
    messageId: string;
    offset: number;
  }>;
}

const MAX_ANCHOR_CANDIDATES = 3;

/** Prefer actual messages: a turn's identity can change when a page fills in its beginning. */
export function captureConversationScrollAnchor(
  container: HTMLElement,
  { includeTurnFallback = true }: { includeTurnFallback?: boolean } = {},
): ConversationScrollAnchor | null {
  const viewport = container.getBoundingClientRect();
  const attributes = includeTurnFallback
    ? Object.values(ConversationScrollAnchorAttribute)
    : [ConversationScrollAnchorAttribute.Message];
  for (const attribute of attributes) {
    const candidates: ConversationScrollAnchor['candidates'] = [];
    for (const element of container.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
      const rect = element.getBoundingClientRect();
      const messageId = element.getAttribute(attribute);
      if (!messageId || rect.height <= 0 || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      candidates.push({
        attribute,
        messageId,
        // A tool-only turn may have no visible text message. Its last message
        // and bottom edge survive prepending the missing beginning of that turn.
        offset: (attribute === ConversationScrollAnchorAttribute.Turn ? rect.bottom : rect.top) - viewport.top,
      });
      if (candidates.length === MAX_ANCHOR_CANDIDATES) break;
    }
    if (candidates.length > 0) return { candidates };
  }
  return null;
}

/** Correct only the remaining displacement; Chromium may already have anchored the content. */
export function restoreConversationScrollAnchor(container: HTMLElement, anchor: ConversationScrollAnchor): boolean {
  for (const candidate of anchor.candidates) {
    const element = Array.from(container.querySelectorAll<HTMLElement>(`[${candidate.attribute}]`))
      .find(item => item.getAttribute(candidate.attribute) === candidate.messageId);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) continue;
    const edge = candidate.attribute === ConversationScrollAnchorAttribute.Turn ? rect.bottom : rect.top;
    const delta = edge - container.getBoundingClientRect().top - candidate.offset;
    if (Math.abs(delta) > 0.5) {
      container.scrollTop = Math.max(0, Math.min(
        container.scrollHeight - container.clientHeight,
        container.scrollTop + delta,
      ));
    }
    return true;
  }
  return false;
}
