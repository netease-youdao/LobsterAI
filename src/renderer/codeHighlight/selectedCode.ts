/** Copy code ranges in DOM order without gutters, +/- markers, file names or hunk headers. */
export function selectedCodeText(container: HTMLElement, selection: Selection | null): string | null {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const lines: string[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const selected = selection.getRangeAt(index);
    if (!container.contains(selected.startContainer) || !container.contains(selected.endContainer)) return null;
    for (const element of container.querySelectorAll('[data-workspace-diff-line-text]')) {
      if (!selected.intersectsNode(element)) continue;
      const line = document.createRange(); line.selectNodeContents(element);
      const overlap = selected.cloneRange();
      if (overlap.compareBoundaryPoints(Range.START_TO_START, line) < 0) overlap.setStart(line.startContainer, line.startOffset);
      if (overlap.compareBoundaryPoints(Range.END_TO_END, line) > 0) overlap.setEnd(line.endContainer, line.endOffset);
      lines.push(overlap.toString());
    }
  }
  return lines.length ? lines.join('\n') : null;
}
