import { PlatformRegistry } from '@shared/platform';

/**
 * 根据语言获取可见的 IM 平台
 */
export const getVisibleIMPlatforms = (language: 'zh' | 'en'): readonly string[] => {
  if (language === 'zh') {
    return PlatformRegistry.platformsByRegion('china');
  }
  return PlatformRegistry.platforms;
};
