export interface ArtifactTabActionTarget {
  id: string;
  active: boolean;
  activate: () => void;
  close: () => void;
}

/** Use each tab's existing close lifecycle, then restore a surviving selection. */
export function artifactTabMenuActions(tabs: ArtifactTabActionTarget[], targetId: string) {
  const index = tabs.findIndex(tab => tab.id === targetId);
  if (index < 0) return {};
  const target = tabs[index];
  const others = tabs.filter(tab => tab.id !== targetId);
  const right = tabs.slice(index + 1);
  const close = (closing: ArtifactTabActionTarget[], keep: ArtifactTabActionTarget) => {
    for (const tab of closing) tab.close();
    // Special-tab close handlers may choose a fallback. The final selection must survive the whole batch.
    keep.activate();
  };
  return {
    onCloseOthers: others.length ? () => close(others, target) : undefined,
    onCloseToRight: right.length ? () => close(right, tabs.slice(0, index + 1).find(tab => tab.active) ?? target) : undefined,
  };
}
