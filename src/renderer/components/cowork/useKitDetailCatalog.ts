import type { Dispatch, UnknownAction } from '@reduxjs/toolkit';
import { useCallback, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { kitService } from '../../services/kit';
import type { RootState } from '../../store';
import { setInstalledKits, setMarketplaceKits } from '../../store/slices/kitSlice';
import type { InstalledKit, MarketplaceKit } from '../../types/kit';

export interface KitDetailCatalogSource {
  fetchMarketplaceKits: () => Promise<MarketplaceKit[]>;
  getInstalledKits: () => Promise<Record<string, InstalledKit>>;
}

/** Loads the kit store and installed kits into the store; returns whether the kit was found. */
export async function loadKitDetailCatalog(
  kitId: string,
  dispatch: Dispatch<UnknownAction>,
  source: KitDetailCatalogSource = kitService,
): Promise<boolean> {
  const [kits, installed] = await Promise.all([source.fetchMarketplaceKits(), source.getInstalledKits()]);
  // An unavailable store comes back empty; keep whatever is already loaded.
  if (kits.length > 0) dispatch(setMarketplaceKits(kits));
  if (Object.keys(installed).length > 0) dispatch(setInstalledKits(installed));
  return kits.some(kit => kit.id === kitId);
}

/**
 * The kit store is only fetched when the kit picker or kit page opens, so a
 * conversation read after a restart has no kit details yet. Opening a kit
 * chip's detail card loads them on demand (kitService caches and dedupes).
 */
export function useKitDetailCatalog(marketplaceKits: MarketplaceKit[]) {
  const dispatch = useDispatch();
  const installedKits = useSelector((state: RootState) => state.kit.installedKits);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  const ensureKitLoaded = useCallback((kitId: string) => {
    if (loadingRef.current || marketplaceKits.some(kit => kit.id === kitId)) return;
    loadingRef.current = true;
    setLoading(true);
    void loadKitDetailCatalog(kitId, dispatch)
      .then((found) => {
        if (!found) {
          console.warn(`[CoworkMessage] Kit ${kitId} is not in the kit store; showing local details only.`);
        }
      })
      .catch((error) => {
        console.error('[CoworkMessage] Failed to load kit details:', error);
      })
      .finally(() => {
        loadingRef.current = false;
        setLoading(false);
      });
  }, [dispatch, marketplaceKits]);

  return { installedKits, loading, ensureKitLoaded };
}
