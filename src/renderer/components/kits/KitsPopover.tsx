import { CheckIcon, Cog6ToothIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { kitService } from '../../services/kit';
import { resolveLocalizedText } from '../../services/skill';
import { RootState } from '../../store';
import { setInstalledKits, setMarketplaceKits } from '../../store/slices/kitSlice';
import type { MarketplaceKit } from '../../types/kit';
import SearchIcon from '../icons/SearchIcon';
import ExpertKitsEmptyIcon from './ExpertKitsEmptyIcon';
import KitIcon from './KitIcon';

const MIN_SEARCHABLE_KIT_COUNT = 3;

interface KitsPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectKit: (kitId: string) => void;
  onManageKits: () => void;
  anchorRef: React.RefObject<HTMLElement>;
}

const KitsPopover: React.FC<KitsPopoverProps> = ({
  isOpen,
  onClose,
  onSelectKit,
  onManageKits,
  anchorRef,
}) => {
  const dispatch = useDispatch();
  const [searchQuery, setSearchQuery] = useState('');
  const [maxListHeight, setMaxListHeight] = useState(300);
  const [isLoading, setIsLoading] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const installedKits = useSelector((state: RootState) => state.kit.installedKits);
  const marketplaceKits = useSelector((state: RootState) => state.kit.marketplaceKits);
  const activeKitIds = useSelector((state: RootState) => state.kit.activeKitIds);

  const installedKitIds = Object.keys(installedKits);

  // Build display list: only installed kits, with marketplace metadata for display
  const installedKitList: MarketplaceKit[] = installedKitIds
    .map(kitId => marketplaceKits.find(mk => mk.id === kitId))
    .filter((k): k is MarketplaceKit => k !== undefined);
  const shouldShowSearch = installedKitList.length >= MIN_SEARCHABLE_KIT_COUNT;

  // Filter by search query
  const filteredKits = installedKitList.filter(kit => {
    if (!shouldShowSearch || !searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const name = resolveLocalizedText(kit.name).toLowerCase();
    const desc = resolveLocalizedText(kit.description).toLowerCase();
    return name.includes(q) || desc.includes(q);
  });

  // Lazy-load data when popover opens
  useEffect(() => {
    if (!isOpen) return;

    const loadData = async () => {
      setIsLoading(true);
      try {
        const [mkKits, installed] = await Promise.all([
          kitService.fetchMarketplaceKits(),
          kitService.getInstalledKits(),
        ]);
        dispatch(setMarketplaceKits(mkKits));
        dispatch(setInstalledKits(installed));
      } catch (error) {
        console.error('[KitsPopover] Failed to load kit data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [isOpen, dispatch]);

  // Calculate available height and focus search input when popover opens
  useEffect(() => {
    if (isOpen) {
      if (anchorRef.current) {
        const anchorRect = anchorRef.current.getBoundingClientRect();
        // Reserve room above the popover plus the search bar and footer chrome
        const availableHeight = anchorRect.top - 120 - 104;
        setMaxListHeight(Math.max(120, Math.min(300, availableHeight)));
      }
      if (shouldShowSearch && searchInputRef.current) {
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    }
    if (!isOpen) {
      setSearchQuery('');
    }
  }, [isOpen, anchorRef, shouldShowSearch]);

  useEffect(() => {
    if (!shouldShowSearch && searchQuery) {
      setSearchQuery('');
    }
  }, [searchQuery, shouldShowSearch]);

  // Handle click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsidePopover = popoverRef.current?.contains(target);
      const isInsideAnchor = anchorRef.current?.contains(target);

      if (!isInsidePopover && !isInsideAnchor) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorRef]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleSelectKit = (kitId: string) => {
    onSelectKit(kitId);
    // Don't close popover to allow multi-selection
  };

  const handleOpenMarketplace = () => {
    onClose();
    onManageKits();
  };

  if (!isOpen) return null;

  const shouldShowInstallGuide = !isLoading && installedKitIds.length === 0;

  return (
    <div
      ref={popoverRef}
      className={`absolute bottom-full left-0 z-50 mb-1 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-popover ${
        shouldShowInstallGuide ? 'w-60' : 'w-80'
      }`}
      role="menu"
    >
      {shouldShowSearch && (
        <div className="px-3 py-2 border-b border-border">
          <div className="relative">
            <SearchIcon className="absolute left-1.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-secondary" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder={i18nService.t('searchKits')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-md bg-transparent py-1.5 pl-8 pr-2 text-[13px] leading-5 text-foreground placeholder-secondary focus:bg-surface-raised/70 focus:outline-none"
            />
          </div>
        </div>
      )}

      {/* Kits list */}
      <div
        className={shouldShowInstallGuide ? 'px-4 py-5' : 'overflow-y-auto px-2 py-1.5'}
        style={shouldShowInstallGuide ? undefined : { maxHeight: `${maxListHeight}px` }}
      >
        {isLoading ? (
          <div className="px-3 py-5 text-center text-[13px] text-secondary">
            {i18nService.t('kitLoading')}
          </div>
        ) : shouldShowInstallGuide ? (
          <div>
            <div className="mb-3 flex justify-center">
              <ExpertKitsEmptyIcon aria-hidden="true" className="h-20 w-20 text-foreground" />
            </div>
            <div className="text-center text-[13px] font-medium text-foreground">
              {i18nService.t('noKitsInstalled')}
            </div>
            <div className="mt-1 text-center text-[12px] text-secondary">
              {i18nService.t('kitInstallGuideDescription')}
            </div>
            <button
              type="button"
              onClick={handleOpenMarketplace}
              className="mt-3 w-full rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary/90"
            >
              {i18nService.t('kitGoInstall')}
            </button>
          </div>
        ) : filteredKits.length === 0 ? (
          <div className="px-3 py-5 text-center text-[13px] text-secondary">
            {i18nService.t('kitSearchNoResults')}
          </div>
        ) : (
          filteredKits.map((kit) => {
            const isActive = activeKitIds.includes(kit.id);
            return (
              <button
                key={kit.id}
                onClick={() => handleSelectKit(kit.id)}
                className={`w-full flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                  isActive
                    ? 'bg-surface-raised'
                    : 'hover:bg-surface-raised'
                }`}
              >
                <KitIcon
                  icon={kit.icon}
                  className="mt-[3px] h-8 w-8"
                  fallbackClassName="rounded-lg bg-primary-muted text-primary"
                  fallbackIconClassName="h-4 w-4"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate text-[13px] font-semibold leading-5 text-foreground">
                      {resolveLocalizedText(kit.name)}
                    </span>
                    {kit.author && (
                      <span className="flex-shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium leading-none text-secondary">
                        {i18nService.t('kitOfficial')}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-[12px] leading-4 text-secondary">
                    {resolveLocalizedText(kit.description)}
                  </p>
                </div>
                {isActive && (
                  <CheckIcon className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-primary" />
                )}
              </button>
            );
          })
        )}
      </div>

      {/* Footer: marketplace entry */}
      {!isLoading && !shouldShowInstallGuide && (
        <div className="border-t border-border p-1.5">
          <button
            type="button"
            onClick={handleOpenMarketplace}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            <Cog6ToothIcon className="h-4 w-4" />
            {i18nService.t('manageKits')}
          </button>
        </div>
      )}
    </div>
  );
};

export default KitsPopover;
