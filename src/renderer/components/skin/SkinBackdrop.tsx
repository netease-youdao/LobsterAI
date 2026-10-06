import React, { useState } from 'react';

import {
  SkinAssetSlot,
  SkinPreferredAppearance,
} from '../../../shared/skin/constants';
import { useSkin, useSkinAsset } from '../../providers/SkinProvider';

export const SkinBackdropVariant = {
  Home: 'home',
  Conversation: 'conversation',
  Management: 'management',
} as const;

export type SkinBackdropVariant = typeof SkinBackdropVariant[keyof typeof SkinBackdropVariant];

interface SkinBackdropProps {
  variant: SkinBackdropVariant;
}

const HOME_OVERLAY = [
  'radial-gradient(ellipse at 50% 47%,',
  'color-mix(in srgb, var(--lobster-background) 62%, transparent) 0%,',
  'color-mix(in srgb, var(--lobster-background) 44%, transparent) 47%,',
  'color-mix(in srgb, var(--lobster-background) 22%, transparent) 100%)',
  ', linear-gradient(to bottom,',
  'color-mix(in srgb, var(--lobster-background) 12%, transparent),',
  'color-mix(in srgb, var(--lobster-background) 54%, transparent))',
].join(' ');

const CONVERSATION_OVERLAY = [
  'linear-gradient(to bottom,',
  'color-mix(in srgb, var(--lobster-background) 20%, transparent),',
  'color-mix(in srgb, var(--lobster-background) 36%, transparent))',
].join(' ');

const PRESENTED_HOME_OVERLAY = [
  'radial-gradient(ellipse at 50% 46%,',
  'color-mix(in srgb, var(--lobster-skin-canvas) 52%, transparent) 0%,',
  'color-mix(in srgb, var(--lobster-skin-canvas) 34%, transparent) 48%,',
  'color-mix(in srgb, var(--lobster-skin-canvas) 18%, transparent) 100%)',
  ', linear-gradient(to bottom,',
  'color-mix(in srgb, var(--lobster-skin-canvas) 12%, transparent),',
  'color-mix(in srgb, var(--lobster-skin-canvas) 82%, transparent))',
].join(' ');

const PRESENTED_CONVERSATION_OVERLAY = [
  'linear-gradient(to bottom,',
  'color-mix(in srgb, var(--lobster-skin-canvas) 44%, transparent),',
  'color-mix(in srgb, var(--lobster-skin-canvas) 62%, transparent))',
].join(' ');

const PRESENTED_DARK_CONVERSATION_OVERLAY = [
  'linear-gradient(to bottom,',
  'color-mix(in srgb, var(--lobster-skin-canvas) 30%, transparent),',
  'color-mix(in srgb, var(--lobster-skin-canvas) 45%, transparent))',
].join(' ');

const PRESENTED_MANAGEMENT_OVERLAY = [
  'linear-gradient(to bottom,',
  'color-mix(in srgb, var(--lobster-skin-canvas) 32%, transparent),',
  'color-mix(in srgb, var(--lobster-skin-canvas) 46%, transparent))',
].join(' ');

const PRESENTED_DARK_MANAGEMENT_OVERLAY = [
  'linear-gradient(to bottom,',
  'color-mix(in srgb, var(--lobster-skin-canvas) 18%, transparent),',
  'color-mix(in srgb, var(--lobster-skin-canvas) 30%, transparent))',
].join(' ');

const SkinBackdrop: React.FC<SkinBackdropProps> = ({ variant }) => {
  const { activeSkin } = useSkin();
  const assetUrl = useSkinAsset(SkinAssetSlot.WorkspaceBackdrop);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const isHome = variant === SkinBackdropVariant.Home;
  const isManagement = variant === SkinBackdropVariant.Management;
  const hasPresentation = Boolean(activeSkin?.presentation);
  const isDarkPresentation = (
    activeSkin?.presentation?.preferredAppearance === SkinPreferredAppearance.Dark
  );

  if (!assetUrl || failedUrl === assetUrl || (isManagement && !hasPresentation)) return null;

  const overlay = hasPresentation
    ? isHome
      ? PRESENTED_HOME_OVERLAY
      : isManagement
        ? isDarkPresentation
          ? PRESENTED_DARK_MANAGEMENT_OVERLAY
          : PRESENTED_MANAGEMENT_OVERLAY
      : isDarkPresentation
        ? PRESENTED_DARK_CONVERSATION_OVERLAY
        : PRESENTED_CONVERSATION_OVERLAY
    : isHome
      ? HOME_OVERLAY
      : CONVERSATION_OVERLAY;
  return (
    <div
      aria-hidden="true"
      data-skin-backdrop={variant}
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      <img
        src={assetUrl}
        alt=""
        draggable={false}
        onError={() => setFailedUrl(assetUrl)}
        style={hasPresentation ? {
          objectPosition: 'var(--lobster-skin-focus-x) var(--lobster-skin-focus-y)',
        } : undefined}
        className={`h-full w-full scale-[1.01] object-cover object-center ${
          hasPresentation
            ? isHome
              ? 'opacity-[0.78]'
              : isManagement
                ? isDarkPresentation
                  ? 'opacity-[0.30] saturate-[0.88]'
                  : 'opacity-[0.26] saturate-[0.88]'
                : 'opacity-[0.26] saturate-[0.88]'
            : isHome
              ? 'opacity-[0.82] dark:opacity-[0.72]'
              : 'opacity-[0.32] saturate-[0.90] dark:opacity-[0.28]'
        }`}
      />
      <div
        className="absolute inset-0"
        style={{ background: overlay }}
      />
    </div>
  );
};

export default SkinBackdrop;
