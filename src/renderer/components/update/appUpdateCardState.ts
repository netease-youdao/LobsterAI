import { localStore } from '../../services/store';

export const APP_UPDATE_CARD_COLLAPSE_KEY = 'app_update_card.collapsed_version';

/**
 * The card starts expanded for every newly discovered version. Collapsing is
 * remembered per version so the user is re-shown the full card when the next
 * release lands, while the collapsed pill keeps a persistent anchor in the
 * sidebar in the meantime.
 */
export const shouldExpandUpdateCard = (
  collapsedVersion: string | null,
  latestVersion: string,
): boolean => collapsedVersion !== latestVersion;

export const readUpdateCardCollapsedVersion = async (): Promise<string | null> => {
  const stored = await localStore.getItem<unknown>(APP_UPDATE_CARD_COLLAPSE_KEY);
  return typeof stored === 'string' && stored.length > 0 ? stored : null;
};

export const saveUpdateCardCollapsedVersion = async (version: string): Promise<void> => {
  await localStore.setItem(APP_UPDATE_CARD_COLLAPSE_KEY, version);
};

export const clearUpdateCardCollapsedVersion = async (): Promise<void> => {
  await localStore.removeItem(APP_UPDATE_CARD_COLLAPSE_KEY);
};
