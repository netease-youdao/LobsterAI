import { PlatformRegistry } from '@shared/platform';

/**
 * 根据语言获取可见的 IM 平台
 * zh: 仅显示 china 区域平台（Telegram/Discord 在国内需翻墙，中文模式下不展示）
 * en: 显示全部平台
 */
export const getVisibleIMPlatforms = (language: 'zh' | 'en'): readonly string[] => {
  if (language === 'zh') {
    return PlatformRegistry.platformsByRegion('china');
  }
  return PlatformRegistry.platforms;
};
