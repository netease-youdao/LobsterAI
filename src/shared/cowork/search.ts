export interface CoworkSearchMessage {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** Zero-based position in the complete mixed-message session timeline. */
  absoluteMessageIndex: number;
}

/** Opaque keyset cursor for the stable mixed-message ordering. */
export interface CoworkSearchMessageCursor {
  sortValue: number;
  createdAt: number;
  rowId: number;
}

export interface CoworkSearchMessagePage {
  messages: CoworkSearchMessage[];
  /** Absolute mixed-message offset inspected by this page. */
  offset: number;
  /** First absolute mixed-message offset not inspected by this page. */
  nextOffset: number;
  /** Cursor of the last inspected mixed-message row, when one was read. */
  nextCursor?: CoworkSearchMessageCursor;
  /** Current number of messages in the complete mixed-message timeline. */
  total: number;
}

/**
 * Best content hit for one session in the cross-session task search. Only
 * user messages and non-thinking assistant messages are searched, matching
 * the in-conversation search.
 */
export interface CoworkSessionContentMatch {
  sessionId: string;
  messageId: string;
  messageType: 'user' | 'assistant';
  /** Single-line excerpt around the most recent matching message's hit. */
  snippet: string;
  /** UTF-16 offset of the hit inside `snippet`, or -1 when it could not be located. */
  highlightStart: number;
  highlightLength: number;
  /** Number of matching messages in the session. */
  matchCount: number;
  matchedAt: number;
}
