import React, { useState } from 'react';

import { SkinAssetSlot } from '../../../shared/skin/constants';
import { useSkin, useSkinAsset } from '../../providers/SkinProvider';
import {
  resolveSkinBackdropLayerStyle,
  SkinBackdropVariant,
} from '../../services/skinBackdropPresentation';

export { SkinBackdropVariant };

interface SkinBackdropProps {
  variant: SkinBackdropVariant;
}

const SkinBackdrop: React.FC<SkinBackdropProps> = ({ variant }) => {
  const { activeSkin } = useSkin();
  const assetUrl = useSkinAsset(SkinAssetSlot.WorkspaceBackdrop);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const isManagement = variant === SkinBackdropVariant.Management;
  const presentation = activeSkin?.presentation;
  const hasPresentation = Boolean(presentation);

  if (!assetUrl || failedUrl === assetUrl || (isManagement && !hasPresentation)) return null;

  const layerStyle = resolveSkinBackdropLayerStyle(variant, presentation);
  return (
    <div
      aria-hidden="true"
      data-skin-backdrop={variant}
      data-skin-backdrop-visibility={layerStyle.visibility}
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
        className={`h-full w-full scale-[1.01] object-cover object-center ${layerStyle.imageClassName}`}
      />
      <div
        className="absolute inset-0"
        style={{ background: layerStyle.overlay }}
      />
    </div>
  );
};

export default SkinBackdrop;
