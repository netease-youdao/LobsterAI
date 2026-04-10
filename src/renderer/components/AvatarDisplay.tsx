import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { avatarService } from '../services/avatar';
import type { RootState } from '../store';
import type { PresetAvatarId, UserAvatarConfig } from '../types/avatar';
import { PRESET_AVATAR_COMPONENTS } from './avatars/presets';

// 随机预置头像选择（基于用户ID或昵称的哈希，保证同一用户始终得到相同头像）
const getRandomPresetAvatar = (seed: string): PresetAvatarId => {
  const presetIds = Object.keys(PRESET_AVATAR_COMPONENTS) as PresetAvatarId[];
  const hash = seed.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return presetIds[hash % presetIds.length];
};

interface AvatarDisplayProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showBorder?: boolean;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}

const sizeMap = {
  sm: 'w-7 h-7 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-16 h-16 text-base',
  xl: 'w-24 h-24 text-xl',
};

export const AvatarDisplay: React.FC<AvatarDisplayProps> = ({
  size = 'sm',
  showBorder = true,
  className = '',
  onClick,
}) => {
  const [avatarConfig, setAvatarConfig] = useState<UserAvatarConfig | null>(null);
  const user = useSelector((state: RootState) => state.auth.user);
  const nickname = user?.nickname || '';

  useEffect(() => {
    loadAvatarConfig();

    // Listen for avatar updates
    const handleAvatarUpdate = () => {
      loadAvatarConfig();
    };

    window.addEventListener('avatar-updated', handleAvatarUpdate);
    return () => {
      window.removeEventListener('avatar-updated', handleAvatarUpdate);
    };
  }, []);

  const loadAvatarConfig = async () => {
    const config = await avatarService.getAvatarConfig();
    setAvatarConfig(config);
  };

  const renderAvatar = () => {
    // If no config, show random preset avatar based on nickname
    if (!avatarConfig) {
      const randomPresetId = getRandomPresetAvatar(nickname);
      const PresetComponent = PRESET_AVATAR_COMPONENTS[randomPresetId];
      if (PresetComponent) {
        return <PresetComponent className="w-full h-full" />;
      }
      return renderDefaultAvatar();
    }

    switch (avatarConfig.type) {
      case 'preset':
        return renderPresetAvatar();
      case 'custom':
        return renderCustomAvatar();
      case 'default':
      default:
        return renderDefaultAvatar();
    }
  };

  const renderPresetAvatar = () => {
    const presetId = avatarConfig?.presetId;
    if (!presetId) return renderDefaultAvatar();

    const PresetComponent = PRESET_AVATAR_COMPONENTS[presetId];
    if (!PresetComponent) return renderDefaultAvatar();

    return <PresetComponent className="w-full h-full" />;
  };

  const renderCustomAvatar = () => {
    const customUrl = avatarConfig?.customUrl;
    if (!customUrl) return renderDefaultAvatar();

    return (
      <img
        src={customUrl}
        alt="Avatar"
        className="w-full h-full object-cover"
      />
    );
  };

  const renderDefaultAvatar = () => {
    const { bg, text } = avatarService.generateDefaultAvatar(nickname);

    return (
      <div
        className={`w-full h-full bg-gradient-to-br ${bg} flex items-center justify-center text-white font-medium`}
      >
        {text}
      </div>
    );
  };

  const sizeClass = sizeMap[size];
  const borderClass = showBorder ? 'border border-border' : '';
  const cursorClass = onClick ? 'cursor-pointer' : '';

  return (
    <div
      className={`${sizeClass} ${borderClass} ${cursorClass} rounded-full overflow-hidden flex-shrink-0 transition-transform hover:scale-105 ${className}`}
      onClick={onClick}
      title={onClick ? '点击设置头像' : ''}
    >
      {renderAvatar()}
    </div>
  );
};

export default AvatarDisplay;
