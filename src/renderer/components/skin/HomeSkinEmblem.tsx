import React, { useState } from 'react';

import { SkinAssetSlot } from '../../../shared/skin/constants';
import { useSkinAsset } from '../../providers/SkinProvider';

interface HomeSkinEmblemProps {
  className?: string;
  /** When true, render only if the active skin provides a custom emblem asset. */
  onlyWhenCustom?: boolean;
}

const HomeSkinEmblem: React.FC<HomeSkinEmblemProps> = ({ className, onlyWhenCustom = false }) => {
  const assetUrl = useSkinAsset(SkinAssetSlot.HomeEmblem);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const shouldUseSkinAsset = Boolean(assetUrl && failedUrl !== assetUrl);
  if (onlyWhenCustom && !shouldUseSkinAsset) {
    return null;
  }
  const imageClassName = [
    className,
    shouldUseSkinAsset ? 'rounded-xl object-cover' : undefined,
  ].filter(Boolean).join(' ');

  return (
    <img
      src={shouldUseSkinAsset ? assetUrl ?? 'logo.png' : 'logo.png'}
      alt="LobsterAI"
      draggable={false}
      onError={() => {
        if (assetUrl) setFailedUrl(assetUrl);
      }}
      className={imageClassName}
    />
  );
};

export default HomeSkinEmblem;
