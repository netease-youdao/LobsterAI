import React, { useEffect, useMemo, useState } from 'react';

import { toLocalFileUrl } from '../../utils/localFileUrl';

interface AgentAvatarProps {
  icon?: string;
  avatarPath?: string;
  avatarPreviewSrc?: string;
  fallbackIcon?: string;
  name?: string;
  className?: string;
  imageClassName?: string;
  emojiClassName?: string;
}

const AgentAvatar: React.FC<AgentAvatarProps> = ({
  icon,
  avatarPath,
  avatarPreviewSrc,
  fallbackIcon = '🤖',
  name,
  className,
  imageClassName,
  emojiClassName,
}) => {
  const [imageFailed, setImageFailed] = useState(false);

  const avatarSrc = useMemo(() => {
    if (typeof avatarPreviewSrc === 'string' && avatarPreviewSrc.trim()) {
      return avatarPreviewSrc.trim();
    }
    if (typeof avatarPath === 'string' && avatarPath.trim()) {
      return toLocalFileUrl(avatarPath);
    }
    return '';
  }, [avatarPath, avatarPreviewSrc]);

  useEffect(() => {
    setImageFailed(false);
  }, [avatarSrc]);

  const displayIcon = icon || fallbackIcon;

  return (
    <div
      className={[
        'flex items-center justify-center overflow-hidden rounded-full border border-border bg-surface-raised',
        className ?? '',
      ].join(' ').trim()}
    >
      {avatarSrc && !imageFailed ? (
        <img
          src={avatarSrc}
          alt={name ? `${name} avatar` : ''}
          className={imageClassName ?? 'h-full w-full object-cover'}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className={emojiClassName ?? 'text-lg leading-none'}>
          {displayIcon}
        </span>
      )}
    </div>
  );
};

export default AgentAvatar;
