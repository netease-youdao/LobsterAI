// Card renderers require a blank line before a Markdown table. DingTalk also
// needs HTML breaks between lines of prose. Keep code fences and block syntax intact.
export function formatCardMarkdown(text, proseBreak = '\n') {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const parts = [];
  const block = /^\s{0,3}(?:\||#{1,6}\s|[-*+]\s|\d+[.)]\s|>|[-*_]{3})/;
  const divider = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
  const fenceStart = /^\s{0,3}(`{3,}|~{3,})/;
  let fence;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = fenceStart.exec(line)?.[1];
    const previous = lines[i - 1];
    if (i > 0) {
      if (!fence && !marker && previous.trim() && !previous.includes('|')
        && line.includes('|') && divider.test(lines[i + 1] ?? '')) {
        parts.push('\n\n');
      } else {
        const keepLines = fence || marker || !line.trim() || !previous.trim() || block.test(line)
          || block.test(previous) || previous.includes('|') || line.includes('|')
          || fenceStart.test(previous);
        parts.push(keepLines ? '\n' : proseBreak);
      }
    }
    parts.push(line);
    if (marker && !fence) fence = marker;
    else if (fence && marker?.startsWith(fence) && line.trim() === marker) fence = undefined;
  }
  return parts.join('');
}
