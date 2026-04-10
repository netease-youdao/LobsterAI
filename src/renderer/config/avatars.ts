import type { PresetAvatarId } from '../types/avatar';

export interface PresetAvatarConfig {
  id: PresetAvatarId;
  name: string;
  nameEn: string;
}

// 预置头像配置列表
export const PRESET_AVATARS: PresetAvatarConfig[] = [
  {
    id: 'aurora',
    name: '极光',
    nameEn: 'Aurora',
  },
  {
    id: 'ocean',
    name: '深海',
    nameEn: 'Ocean',
  },
  {
    id: 'flame',
    name: '火焰',
    nameEn: 'Flame',
  },
  {
    id: 'forest',
    name: '森林',
    nameEn: 'Forest',
  },
  {
    id: 'sunset',
    name: '日落',
    nameEn: 'Sunset',
  },
  {
    id: 'nebula',
    name: '星云',
    nameEn: 'Nebula',
  },
];

// 获取预置头像配置
export const getPresetAvatarConfig = (id: PresetAvatarId): PresetAvatarConfig | undefined => {
  return PRESET_AVATARS.find(avatar => avatar.id === id);
};
