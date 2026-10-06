import React, { useState } from 'react';
import { useDispatch } from 'react-redux';

import { SkinAssetSlot } from '../../../shared/skin/constants';
import { useSkin } from '../../providers/SkinProvider';
import { i18nService } from '../../services/i18n';
import { buildSkinAssetUrl } from '../../services/skin';
import { prepareSkinKitOnboarding } from '../../services/skinKitOnboarding';
import {
  setInstalledKits,
  setMarketplaceKits,
} from '../../store/slices/kitSlice';
import MagicIcon from '../icons/MagicIcon';
import TrashIcon from '../icons/TrashIcon';
import SkinDeleteConfirmDialog from './SkinDeleteConfirmDialog';

const SkinActionErrorKind = {
  Apply: 'apply',
  Delete: 'delete',
} as const;

type SkinActionError = typeof SkinActionErrorKind[keyof typeof SkinActionErrorKind] | null;

const SkinActionErrorI18nKey = {
  [SkinActionErrorKind.Apply]: 'aiSkinApplyFailed',
  [SkinActionErrorKind.Delete]: 'aiSkinDeleteFailed',
} as const;

interface PendingSkinDeletion {
  id: string;
  label: string;
  isActive: boolean;
}

interface SkinSettingsSectionProps {
  onStartAiSkin?: (text: string, kitId: string) => void;
}

const SkinSettingsSection: React.FC<SkinSettingsSectionProps> = ({ onStartAiSkin }) => {
  const dispatch = useDispatch();
  const {
    activeSkin,
    apply,
    deleteSkin,
    isAppearanceChanging,
    isLoading,
    refreshVersion,
    savedSkins,
  } = useSkin();
  const [applyingSkinId, setApplyingSkinId] = useState<string | null>(null);
  const [deletingSkinId, setDeletingSkinId] = useState<string | null>(null);
  const [isStartingAiSkin, setIsStartingAiSkin] = useState(false);
  const [actionError, setActionError] = useState<SkinActionError>(null);
  const [startError, setStartError] = useState(false);
  const [pendingDeletion, setPendingDeletion] = useState<PendingSkinDeletion | null>(null);

  const handleApply = async (skinId: string) => {
    if (skinId === activeSkin?.id) return;
    setActionError(null);
    setApplyingSkinId(skinId);
    try {
      await apply(skinId);
    } catch (error) {
      console.error('[Skin] Failed to apply a saved skin', error);
      setActionError(SkinActionErrorKind.Apply);
    } finally {
      setApplyingSkinId(null);
    }
  };

  const handleDelete = async () => {
    if (!pendingDeletion) return;
    setActionError(null);
    setDeletingSkinId(pendingDeletion.id);
    try {
      await deleteSkin(pendingDeletion.id);
      setPendingDeletion(null);
    } catch (error) {
      console.error('[Skin] Failed to delete a saved skin', error);
      setActionError(SkinActionErrorKind.Delete);
      setPendingDeletion(null);
    } finally {
      setDeletingSkinId(null);
    }
  };

  const handleStartAiSkin = async () => {
    if (!onStartAiSkin) return;
    setStartError(false);
    setIsStartingAiSkin(true);
    try {
      const prepared = await prepareSkinKitOnboarding();
      dispatch(setMarketplaceKits(prepared.marketplaceKits));
      dispatch(setInstalledKits(prepared.installedKits));
      onStartAiSkin(prepared.prompt, prepared.kitId);
    } catch (error) {
      console.error('[Skin] Failed to start AI skin onboarding', error);
      setStartError(true);
    } finally {
      setIsStartingAiSkin(false);
    }
  };

  const isMutating = applyingSkinId !== null
    || deletingSkinId !== null
    || isStartingAiSkin
    || isAppearanceChanging;

  return (
    <section className="mt-5 rounded-xl border border-border bg-surface px-4 py-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-foreground">
            {i18nService.t('aiSkin')}
          </h4>
          <p className="mt-1 text-xs leading-5 text-secondary">
            {i18nService.t('aiSkinCreationGuide')}
          </p>
        </div>
        {onStartAiSkin && (
          <button
            type="button"
            onClick={() => void handleStartAiSkin()}
            disabled={isMutating}
            className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-primary px-3.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            <MagicIcon className="mr-1.5 h-3.5 w-3.5" />
            {isStartingAiSkin
              ? i18nService.t('aiSkinStarting')
              : i18nService.t('aiSkinCreate')}
          </button>
        )}
      </div>
      {(actionError || startError) && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          {actionError
            ? i18nService.t(SkinActionErrorI18nKey[actionError])
            : i18nService.t('aiSkinStartFailed')}
        </p>
      )}

      {savedSkins.length > 0 ? (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {savedSkins.map((skin) => {
              const isActive = skin.id === activeSkin?.id;
              const isApplying = applyingSkinId === skin.id;
              const backdropUrl = buildSkinAssetUrl(
                skin.assets[SkinAssetSlot.WorkspaceBackdrop],
                refreshVersion,
              );
              const emblemUrl = buildSkinAssetUrl(
                skin.assets[SkinAssetSlot.HomeEmblem],
                refreshVersion,
              );
              const label = skin.name ?? skin.id;

              return (
                <article
                  key={skin.id}
                  className={`relative h-36 overflow-hidden rounded-xl border bg-background transition-[border-color,box-shadow] ${
                    isActive ? 'border-primary ring-1 ring-primary/20' : 'border-border'
                  }`}
                >
                  {backdropUrl && (
                    <img
                      src={backdropUrl}
                      alt=""
                      draggable={false}
                      className="absolute inset-0 h-full w-full object-cover object-center"
                    />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-black/5" />
                  {emblemUrl && (
                    <img
                      src={emblemUrl}
                      alt=""
                      draggable={false}
                      className="absolute left-3 top-3 h-11 w-11 rounded-lg border border-white/40 bg-white/85 object-contain p-1 shadow-sm"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => void handleApply(skin.id)}
                    disabled={isLoading || isMutating}
                    aria-pressed={isActive}
                    aria-busy={isApplying}
                    aria-label={`${isActive
                      ? i18nService.t('aiSkinCurrent')
                      : i18nService.t('aiSkinApply')}: ${label}`}
                    className={`absolute inset-0 z-10 rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:cursor-wait ${
                      isActive ? 'cursor-default' : 'cursor-pointer hover:bg-white/[0.04]'
                    }`}
                  />
                  {(isActive || isApplying) && (
                    <span className="pointer-events-none absolute right-3 top-3 z-20 rounded-full bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground shadow-sm">
                      {isApplying
                        ? i18nService.t('aiSkinApplying')
                        : i18nService.t('aiSkinCurrent')}
                    </span>
                  )}
                  <span className="pointer-events-none absolute bottom-3 left-3 right-12 z-20 truncate text-sm font-medium text-white drop-shadow-sm">
                    {label}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setPendingDeletion({
                        id: skin.id,
                        label,
                        isActive,
                      })
                    }
                    disabled={isLoading || isMutating}
                    title={i18nService.t('aiSkinDelete')}
                    aria-label={i18nService.t('aiSkinDeleteLabel').replace('{name}', label)}
                    className="absolute bottom-3 right-3 z-20 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-background/90 text-destructive shadow-sm backdrop-blur-sm transition-colors hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </article>
              );
          })}
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background px-4 py-4 text-secondary">
          {!isLoading && <MagicIcon className="h-4 w-4" />}
          <p className="text-xs">
            {isLoading ? i18nService.t('loading') : i18nService.t('aiSkinEmpty')}
          </p>
        </div>
      )}
      {pendingDeletion && (
        <SkinDeleteConfirmDialog
          skinName={pendingDeletion.label}
          isActive={pendingDeletion.isActive}
          isDeleting={deletingSkinId === pendingDeletion.id}
          onCancel={() => setPendingDeletion(null)}
          onConfirm={() => void handleDelete()}
        />
      )}
    </section>
  );
};

export default SkinSettingsSection;
