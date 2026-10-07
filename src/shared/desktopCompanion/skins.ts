import { DEFAULT_COMPANION_SKIN } from './constants';

export interface CompanionSkin {
  id: string;
  nameKey: string;
  /** Relative to the companion page; null for the vector character drawn in code. */
  asset: string | null;
  /** Accent used for the working ring and selection highlights. */
  accent: string;
}

export const COMPANION_SKINS: readonly CompanionSkin[] = [
  { id: DEFAULT_COMPANION_SKIN, nameKey: 'desktopCompanionSkinLobster', asset: null, accent: '#F2482A' },
  { id: 'ruanruanxia', nameKey: 'desktopCompanionSkinRuanruanxia', asset: './desktop-companion/skins/ruanruanxia.webp', accent: '#EE3B2F' },
  { id: 'xingxingxing', nameKey: 'desktopCompanionSkinXingxingxing', asset: './desktop-companion/skins/xingxingxing.webp', accent: '#F4A62A' },
  { id: 'shaee', nameKey: 'desktopCompanionSkinShaee', asset: './desktop-companion/skins/shaee.webp', accent: '#2F8BEA' },
  { id: 'zhangduoduo', nameKey: 'desktopCompanionSkinZhangduoduo', asset: './desktop-companion/skins/zhangduoduo.webp', accent: '#E2392F' },
  { id: 'jingyiming', nameKey: 'desktopCompanionSkinJingyiming', asset: './desktop-companion/skins/jingyiming.webp', accent: '#2A7FE0' },
  { id: 'liuliuyu', nameKey: 'desktopCompanionSkinLiuliuyu', asset: './desktop-companion/skins/liuliuyu.webp', accent: '#F26B1D' },
  { id: 'danpapa', nameKey: 'desktopCompanionSkinDanpapa', asset: './desktop-companion/skins/danpapa.webp', accent: '#F2B829' },
  { id: 'qingqingpiao', nameKey: 'desktopCompanionSkinQingqingpiao', asset: './desktop-companion/skins/qingqingpiao.webp', accent: '#8C7CF0' },
];

export function normalizeCompanionSkin(value: unknown): string {
  return typeof value === 'string' && COMPANION_SKINS.some(skin => skin.id === value) ? value : DEFAULT_COMPANION_SKIN;
}

export function getCompanionSkin(id: string): CompanionSkin {
  return COMPANION_SKINS.find(skin => skin.id === id) ?? COMPANION_SKINS[0];
}
