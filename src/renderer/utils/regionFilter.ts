import { RETAINED_IM_PLATFORM_LIST } from '@shared/dshEngine/hostConstants';
import { PlatformRegistry } from '@shared/platform';

const RETAINED_IM_SET = new Set<string>(RETAINED_IM_PLATFORM_LIST);

/**
 * Return visible IM platforms for the active locale, restricted to the
 * retained platforms (`@lobsterai/dsh-channels`).
 */
export const getVisibleIMPlatforms = (language: 'zh' | 'en'): readonly string[] => {
  const candidates = language === 'zh'
    ? PlatformRegistry.platformsByRegion('china')
    : PlatformRegistry.platforms;
  return candidates.filter((platform) => RETAINED_IM_SET.has(platform));
};
