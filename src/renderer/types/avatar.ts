// 头像类型
export type AvatarType = 'preset' | 'custom' | 'default';

// 预置头像ID
export type PresetAvatarId = 'aurora' | 'ocean' | 'flame' | 'forest' | 'sunset' | 'nebula';

// 用户头像配置
export interface UserAvatarConfig {
  type: AvatarType;
  // 预置头像时存储ID
  presetId?: PresetAvatarId;
  // 自定义头像时存储DataUrl
  customUrl?: string;
  // 最后更新时间
  updatedAt?: number;
}
