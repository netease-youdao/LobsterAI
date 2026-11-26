import type { CoworkSideChatSummary } from '../../../shared/cowork/sideChat';

const MAX_PERMISSION_PREVIEW_CHARS = 420;

/**
 * Format a side chat's display title as `<localizedBase> <ordinal>` (e.g.
 * "侧边聊天 1", "侧边聊天 2", "Side chat 1") ordered by creation time.
 */
export function getSideChatDisplayTitle(
  sideChatId: string,
  allSummaries: ReadonlyArray<Pick<CoworkSideChatSummary, 'id' | 'createdAt'>>,
  localizedBase: string,
): string {
  const ordered = [...allSummaries].sort(
    (a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id),
  );
  const index = ordered.findIndex((item) => item.id === sideChatId);
  const ordinal = index >= 0 ? index + 1 : ordered.length + 1;
  return `${localizedBase} ${ordinal}`;
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
