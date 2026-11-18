const IMAGE_HISTORY_DIAGNOSTIC = '[session:history] omitted image payload: missing data or mimeType';

/** Hide a leaked runtime sentinel, while preserving quoted diagnostics and code examples. */
export function stripAssistantImageDiagnostic(text: string): string {
  if (!text.includes(IMAGE_HISTORY_DIAGNOSTIC)) return text;
  let fence: { marker: string; length: number } | undefined;
  let changed = false;
  const lines = text.split('\n').filter(line => {
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (boundary) {
      if (!fence) fence = { marker: boundary[1][0], length: boundary[1].length };
      else if (boundary[1][0] === fence.marker && boundary[1].length >= fence.length && !boundary[2].trim()) fence = undefined;
      return true;
    }
    if (!fence && line.replace(/\r$/, '') === IMAGE_HISTORY_DIAGNOSTIC) {
      changed = true;
      return false;
    }
    return true;
  });
  return changed ? lines.join('\n').trimEnd() : text;
}
