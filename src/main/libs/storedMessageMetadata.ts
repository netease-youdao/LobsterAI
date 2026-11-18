/**
 * Preserve valid stored JSON as-is; schema validation belongs to its consumers.
 * A malformed metadata field must not prevent the rest of a message from loading.
 */
export function parseStoredMessageMetadata(
  metadata: string | null | undefined,
  onCorrupt: () => void,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    onCorrupt();
    return undefined;
  }
}
