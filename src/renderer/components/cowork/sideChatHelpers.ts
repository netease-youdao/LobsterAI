import {
  CoworkSideChatStatus,
  type CoworkSideChatSummary,
} from '../../../shared/cowork/sideChat';

const MAX_PERMISSION_PREVIEW_CHARS = 420;
const DEFAULT_SIDE_CHAT_TITLE_PATTERN = /^(?:Side chat|侧边聊天)(?:\s+\d+)?$/i;

export function isDefaultSideChatTitle(title: string | null | undefined): boolean {
  const trimmed = title?.trim() ?? '';
  return trimmed.length === 0 || DEFAULT_SIDE_CHAT_TITLE_PATTERN.test(trimmed);
}

/**
 * Format an open side chat tab's label based only on currently open tabs.
 * Shows the plain localized base when a single tab is open (e.g. "侧边聊天"),
 * and appends a 1-based ordinal when multiple tabs are open (e.g. "侧边聊天 1", "侧边聊天 2").
 */
export function getOpenSideChatTabTitle(
  tabIndex: number,
  openTabCount: number,
  localizedBase: string,
): string {
  if (openTabCount <= 1) {
    return localizedBase;
  }
  return `${localizedBase} ${Math.max(0, tabIndex) + 1}`;
}

/**
 * Format a side chat's display title. Custom user-renamed titles take
 * precedence; untouched default titles render as `<localizedBase> <ordinal>`
 * (e.g. "侧边聊天 1", "Side chat 1") ordered by creation time.
 */
export function getSideChatDisplayTitle(
  sideChatId: string,
  allSummaries: ReadonlyArray<Pick<CoworkSideChatSummary, 'id' | 'createdAt'> & { title?: string }>,
  localizedBase: string,
): string {
  const target = allSummaries.find((item) => item.id === sideChatId);
  if (target?.title && !isDefaultSideChatTitle(target.title)) {
    return target.title.trim();
  }
  const ordered = [...allSummaries].sort(
    (a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id),
  );
  const index = ordered.findIndex((item) => item.id === sideChatId);
  const ordinal = index >= 0 ? index + 1 : ordered.length + 1;
  return `${localizedBase} ${ordinal}`;
}

export type SideChatPromoteDisabledReasonKey =
  | 'coworkSideChatPromoteRunningHint'
  | 'coworkSideChatPromoteEmptyHint';

export interface SideChatPromoteEligibility {
  allowed: boolean;
  reasonKey?: SideChatPromoteDisabledReasonKey;
}

export function getSideChatPromoteEligibility(
  sideChat: Pick<CoworkSideChatSummary, 'status' | 'messageCount'> | null | undefined,
): SideChatPromoteEligibility {
  if (!sideChat) {
    return { allowed: false, reasonKey: 'coworkSideChatPromoteEmptyHint' };
  }
  if (sideChat.status === CoworkSideChatStatus.Running) {
    return { allowed: false, reasonKey: 'coworkSideChatPromoteRunningHint' };
  }
  if (sideChat.messageCount <= 0) {
    return { allowed: false, reasonKey: 'coworkSideChatPromoteEmptyHint' };
  }
  return { allowed: true };
}

/**
 * Format a compact single-block preview of tool approval inputs inside the
 * inline side-chat approval card.
 */
export function formatSideChatApprovalPreview(toolInput: Record<string, unknown>): string {
  const candidateKeys = ['command', 'cmd', 'file_path', 'filePath', 'path', 'url', 'description'];
  for (const key of candidateKeys) {
    const value = toolInput[key];
    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim();
      return trimmed.length > MAX_PERMISSION_PREVIEW_CHARS
        ? `${trimmed.slice(0, MAX_PERMISSION_PREVIEW_CHARS - 1)}…`
        : trimmed;
    }
  }
  const filteredEntries = Object.entries(toolInput).filter(
    ([key, value]) => value !== undefined && key !== 'callId' && key !== 'toolName',
  );
  if (filteredEntries.length === 0) return '';
  try {
    const serialized = JSON.stringify(Object.fromEntries(filteredEntries), null, 2);
    return serialized.length > MAX_PERMISSION_PREVIEW_CHARS
      ? `${serialized.slice(0, MAX_PERMISSION_PREVIEW_CHARS - 1)}…`
      : serialized;
  } catch {
    return '';
  }
}
