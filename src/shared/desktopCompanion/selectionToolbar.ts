import { CompanionSelectionAction } from './selectionActions';

export const CompanionToolbarItem = {
  ...CompanionSelectionAction,
  Copy: 'copy',
  ReadAloud: 'read-aloud',
} as const;
export type CompanionToolbarItem = typeof CompanionToolbarItem[keyof typeof CompanionToolbarItem];

export const COMPANION_TOOLBAR_VISIBLE_COUNT = 4;

export const DEFAULT_COMPANION_TOOLBAR_ORDER: readonly CompanionToolbarItem[] = [
  CompanionToolbarItem.Translate,
  CompanionToolbarItem.Copy,
  CompanionToolbarItem.ReadAloud,
  CompanionToolbarItem.Summarize,
  CompanionToolbarItem.Explain,
  CompanionToolbarItem.Ask,
];

/** Preserve a saved order while repairing old, duplicate or unknown entries. */
export function normalizeCompanionToolbarOrder(value: unknown): CompanionToolbarItem[] {
  const saved = Array.isArray(value) ? value.filter((item): item is CompanionToolbarItem => (
    DEFAULT_COMPANION_TOOLBAR_ORDER.includes(item)
  )) : [];
  return [...new Set([...saved, ...DEFAULT_COMPANION_TOOLBAR_ORDER])];
}

export function companionToolbarItems(value: unknown) {
  const order = normalizeCompanionToolbarOrder(value);
  return {
    visible: order.slice(0, COMPANION_TOOLBAR_VISIBLE_COUNT),
    overflow: order.slice(COMPANION_TOOLBAR_VISIBLE_COUNT),
  };
}
