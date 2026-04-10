import AuroraAvatar from './AuroraAvatar';
import OceanAvatar from './OceanAvatar';
import FlameAvatar from './FlameAvatar';
import ForestAvatar from './ForestAvatar';
import SunsetAvatar from './SunsetAvatar';
import NebulaAvatar from './NebulaAvatar';

export {
  AuroraAvatar,
  OceanAvatar,
  FlameAvatar,
  ForestAvatar,
  SunsetAvatar,
  NebulaAvatar,
};

// 预置头像组件映射
export const PRESET_AVATAR_COMPONENTS = {
  aurora: AuroraAvatar,
  ocean: OceanAvatar,
  flame: FlameAvatar,
  forest: ForestAvatar,
  sunset: SunsetAvatar,
  nebula: NebulaAvatar,
} as const;

export type PresetAvatarComponent = typeof PRESET_AVATAR_COMPONENTS[keyof typeof PRESET_AVATAR_COMPONENTS];
