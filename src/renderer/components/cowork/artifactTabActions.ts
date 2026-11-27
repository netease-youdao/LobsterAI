export interface ArtifactTabActionTarget {
  id: string;
  active: boolean;
  activate: () => void;
  close: () => void;
}

export interface ArtifactTabMenuActionOptions {
  onClosePanel?: () => void;
}

export interface ArtifactTabMenuShortcutEntry {
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export function resolveArtifactTabMenuShortcut(
  key: string,
  entries: ReadonlyArray<ArtifactTabMenuShortcutEntry>,
): (() => void) | null {
  const normalized = key.trim().toLowerCase();
  if (normalized.length !== 1) return null;
  for (const entry of entries) {
    if (entry.disabled || !entry.shortcut) continue;
    if (entry.shortcut.trim().toLowerCase() === normalized) {
      return entry.onSelect;
    }
  }
  return null;
}

/** Use each tab's existing close lifecycle, then restore a surviving selection. */
export function artifactTabMenuActions(
  tabs: ArtifactTabActionTarget[],
  targetId: string,
  options?: ArtifactTabMenuActionOptions,
) {
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
    onCloseAll: tabs.length > 1 ? () => {
      for (const tab of tabs) tab.close();
      options?.onClosePanel?.();
    } : undefined,
  };
}
